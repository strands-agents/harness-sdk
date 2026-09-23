import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const picker = vi.hoisted(() => ({
  available: false,
  chooseSaveFile: vi.fn<() => Promise<string | undefined>>(),
}))

vi.mock('../src/tui/terminal/directory-picker.js', () => ({
  canChooseDirectory: () => picker.available,
  chooseSaveFile: picker.chooseSaveFile,
}))

import {
  ChatController,
  type ChatBackend,
  type ChatControllerApi,
  type ChatPanelRow,
} from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { createInteractiveChat } from '../src/tui/runtime.js'

const model = 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0'
const profile = defineHarnessAgentConfig({
  name: 'Export fixture',
  model,
  effort: 'off',
  builtinTools: [],
  builtinPlugins: [],
  skills: false,
  memory: false,
  session: false,
  contextManager: false,
})
const controllers: ChatControllerApi[] = []
let root: string
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strands-export-path-'))
  workspace = join(root, 'workspace')
  await mkdir(workspace)
  picker.available = false
  picker.chooseSaveFile.mockReset()
  vi.stubEnv('AWS_REGION', 'us-east-1')
})

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function config(): CliConfigStore {
  return CliConfigStore.memory(
    {},
    { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false },
    { profile, profileBaseDir: workspace }
  )
}

async function profileChat(): Promise<ChatControllerApi> {
  const controller = await createInteractiveChat({
    config: config(),
    agentProfile: profile,
    agentOptions: { ...(await harnessAgentOptionsFromConfig(profile, workspace)), backgroundTasks: false },
    cwd: workspace,
    sessionCatalogPath: join(root, 'catalog.json'),
  })
  controllers.push(controller)
  return controller
}

function backend(): ChatBackend {
  return {
    id: 'test',
    name: 'My agent',
    protocol: 'strands',
    async *stream() {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel() {},
  }
}

function presentationChat(options: NonNullable<ConstructorParameters<typeof ChatController>[1]> = {}): ChatController {
  const controller = new ChatController(backend(), options)
  controllers.push(controller)
  return controller
}

function row(controller: ChatController, label: string): ChatPanelRow {
  const result = controller.getSnapshot().panel?.rows.find((candidate) => candidate.label === label)
  expect(result, `Missing row: ${label}`).toBeDefined()
  return result!
}

it.each(['typescript', 'python'] as const)('writes a %s profile ZIP to an explicit path', async (language) => {
  const controller = await profileChat()
  const name = `my ${language} agent.zip`
  await controller.submit(`/export ${language} ${name}`)

  const path = join(workspace, name)
  expect(controller.getSnapshot().panel).toMatchObject({
    title: 'Export complete',
    body: expect.stringContaining(path),
  })
  expect(unzipSync(await readFile(path))).toHaveProperty(
    language === 'typescript' ? 'agent/agent.ts' : 'agent/agent.py'
  )
  expect(picker.chooseSaveFile).not.toHaveBeenCalled()
})

it('does not overwrite an existing explicit destination', async () => {
  const path = join(workspace, 'existing.zip')
  await writeFile(path, 'keep this file')
  const controller = await profileChat()

  await controller.submit('/export typescript existing.zip')

  expect(controller.getSnapshot().panel?.rows[0]?.description).toContain('already exists')
  expect(await readFile(path, 'utf8')).toBe('keep this file')
  expect(picker.chooseSaveFile).not.toHaveBeenCalled()
})

it.each(['rust agent.zip', 'typescript', 'typescript ""'])('rejects invalid export arguments: %s', async (argument) => {
  const exportAgentProject = vi.fn()
  const controller = presentationChat({ exportAgentProject })

  await controller.submit(`/export ${argument}`)

  expect(controller.getSnapshot().panel).toMatchObject({
    kind: 'error',
    rows: [expect.objectContaining({ description: 'Usage: /export <typescript|python> <path.zip>' })],
  })
  expect(exportAgentProject).not.toHaveBeenCalled()
})

it('shows command guidance when a native save picker is unavailable', async () => {
  const controller = await profileChat()
  await controller.submit('/export')

  expect(controller.getSnapshot().panel?.body).toContain('/export <typescript|python> <path.zip>')
  await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
  expect(controller.getSnapshot().panel).toMatchObject({
    kind: 'error',
    rows: [expect.objectContaining({ description: 'Use /export typescript <path.zip> to save this agent.' })],
  })
})

it.each(['typescript', 'python'] as const)('shows only the authored %s source language', async (language) => {
  const project = {
    root: '/tmp/my agent',
    entrypoint: `/tmp/my agent/agent.${language === 'python' ? 'py' : 'ts'}`,
    language,
  }
  const controller = presentationChat({ project, exportAgentProject: vi.fn() })

  await controller.submit('/export')

  expect(controller.getSnapshot().panel).toMatchObject({
    kind: 'export',
    title: 'Export · My agent',
    body: expect.stringContaining(project.entrypoint),
    rows: [expect.objectContaining({ value: `export:${language}` })],
  })
})

describe('export completion', () => {
  beforeEach(() => {
    picker.available = true
  })

  it('copies the exact path and a shell-safe launch command', async () => {
    const path = "/tmp/Jane's agent $(literal) `literal`\ncopy.zip"
    const copyText = vi.fn(async (_text: string) => true)
    const controller = presentationChat({ copyText, exportAgentProject: async () => path })
    await controller.submit('/export')
    await controller.activatePanelRow(row(controller, 'Python'))

    await controller.activatePanelRow(row(controller, 'Copy path'))
    expect(copyText).toHaveBeenLastCalledWith(path)
    await controller.activatePanelRow(row(controller, 'Copy launch command'))
    const launchCommand = copyText.mock.lastCall![0]
    expect(row(controller, 'Copy launch command').badge?.text).toBe('Copied')
    expect(
      execFileSync('/bin/sh', ['-c', `${launchCommand.replace(/^strands /u, 'set -- ')}; printf '%s' "$2"`], {
        encoding: 'utf8',
      })
    ).toBe(path)
  })

  it.each(['cancel', 'error', 'copy-false', 'copy-error'] as const)(
    'does not report false success for %s',
    async (outcome) => {
      const controller = presentationChat({
        exportAgentProject: async () => {
          if (outcome === 'error') throw new Error('Save failed')
          return outcome === 'cancel' ? undefined : '/tmp/agent.zip'
        },
        copyText: async () => {
          if (outcome === 'copy-error') throw new Error('Clipboard failed')
          return false
        },
      })
      await controller.submit('/export')
      await controller.activatePanelRow(row(controller, 'TypeScript'))

      if (outcome === 'cancel') {
        expect(controller.getSnapshot().panel?.title).toBe('Export · My agent')
      } else if (outcome === 'error') {
        expect(controller.getSnapshot().panel?.kind).toBe('error')
      } else {
        expect(await controller.activatePanelRow(row(controller, 'Copy path'))).toBe(false)
        expect(row(controller, 'Copy path').badge?.text).toBe('Copy failed')
      }
      expect(controller.busy).toBe(false)
    }
  )
})
