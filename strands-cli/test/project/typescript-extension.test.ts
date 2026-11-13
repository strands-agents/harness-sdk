import type { JSONValue } from '@strands-agents/sdk'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentExtensionHost } from '../../src/agent/extension.js'
import { temporaryCreateExperimentSkill } from '../../src/dev/temporary-evals-fork/create-experiment-skill.js'
import { AgentMessaging } from '../../src/agent/messaging.js'
import type { ChatEvent } from '../../src/agent/types.js'
import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { exportSourceProject } from '../../src/project/export.js'
import { importAgentProject } from '../../src/project/import.js'
import { TypescriptBackend } from '../../src/project/typescript-backend.js'

const source = `
import { createHarness } from '@strands-agents/harness'
import { Model } from '@strands-agents/sdk'
const lastUserText = (messages) => {
  const last = messages.at(-1)
  return last?.role === 'user' ? last.content.find((block) => block.type === 'textBlock')?.text ?? '' : ''
}
const promptText = (prompt) =>
  typeof prompt === 'string' ? prompt : (prompt ?? []).map((block) => block.text ?? '').join('\\n')
class LocalModel extends Model {
  getConfig() { return { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', contextWindowLimit: 10000 } }
  updateConfig() {}
  async *stream(messages, options) {
    const text = lastUserText(messages)
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (text.startsWith('{')) {
      const request = JSON.parse(text)
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: request.tool, toolUseId: 'call-1' } }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(request.input ?? {}) } }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      return
    }
    const reply = text === 'echo system' ? promptText(options?.systemPrompt) : 'done'
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: reply } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}
export const agent = await createHarness({
  model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0', effort: 'off', caching: false,
  instructions: 'You answer refund questions.', builtinTools: [], builtinPlugins: [], memory: false,
  session: false, skills: false, contextManager: false, agentConfig: { backgroundTasks: false, printer: false },
})
agent.model = new LocalModel()
`

const extensionHost = (calls: [string, JSONValue][]): AgentExtensionHost => ({
  extension: {
    instructions: '<strands_dev>\nWorkspace folder: /work/strands-dev\n</strands_dev>',
    skills: [temporaryCreateExperimentSkill()],
    tools: [
      {
        name: 'strands_dev_status',
        description: 'Show the workspace',
        inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
        readOnly: true,
      },
      { name: 'strands_dev_test', description: 'Run a test', inputSchema: { type: 'object', properties: {} } },
    ],
  },
  call: async (name, input): Promise<string> => {
    calls.push([name, input])
    if (name === 'strands_dev_test') throw new Error('There is no experiment named refunds.')
    return 'two experiments'
  },
})

describe('TypeScript agent extension', () => {
  let root: string
  const backends: TypescriptBackend[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-typescript-extension-'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'agent.ts'), source)
  })

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  const open = async (calls: [string, JSONValue][], dev = true): Promise<TypescriptBackend> => {
    const config = CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false })
    const { backend } = await TypescriptBackend.open(
      {
        project: importAgentProject(join(root, 'agent.ts')),
        args: parseArgs([]),
        cwd: root,
        initialWorkspace: root,
        peerEndpointId: 'agent-1',
        mcpPaths: [],
        mcpStrictPaths: [],
      },
      config,
      new AgentMessaging(),
      AbortSignal.timeout(15_000),
      dev ? extensionHost(calls) : undefined
    )
    backends.push(backend)
    return backend
  }

  const turn = async (backend: TypescriptBackend, prompt: string): Promise<ChatEvent[]> => {
    const events: ChatEvent[] = []
    for await (const event of backend.stream(prompt)) events.push(event)
    return events
  }

  const text = (events: readonly ChatEvent[]): string =>
    events.flatMap((event) => (event.type === 'textDelta' ? [event.text] : [])).join('')

  it('shouldAppendTheInstructionsAfterTheAuthoredPromptWhenTheAgentStarts', { timeout: 30_000 }, async () => {
    const backend = await open([])

    const prompt = text(await turn(backend, 'echo system'))

    expect(prompt).toContain('You answer refund questions.')
    expect(prompt.indexOf('Workspace folder: /work/strands-dev')).toBeGreaterThan(
      prompt.indexOf('You answer refund questions.')
    )
  })

  it('shouldKeepTheDevSkillOutOfStandaloneExportsAndPlainAgentLoads', { timeout: 30_000 }, async () => {
    const dev = await open([])
    expect((await dev.skills.list()).map(({ name }) => name)).toContain('create-experiment')
    expect(text(await turn(dev, 'echo system'))).toContain('<strands_dev>')
    expect(JSON.stringify(dev.state.profile)).not.toContain('create-experiment')
    expect(JSON.stringify(dev.state.profile)).not.toContain('strands_dev')

    const destination = join(root, 'exported-agent')
    await exportSourceProject(
      importAgentProject(join(root, 'agent.ts')),
      'Refunds',
      'typescript',
      [],
      destination,
      'directory'
    )
    const exported = await readFile(join(destination, 'agent.ts'), 'utf8')
    expect(exported).toBe(source)
    expect(exported).not.toContain('create-experiment')
    expect(exported).not.toContain('strands_dev')

    const plain = await open([], false)
    expect(text(await turn(plain, 'echo system'))).not.toContain('<strands_dev>')
    expect((await plain.skills.list()).map(({ name }) => name)).not.toContain('create-experiment')
    expect(plain.info().tools?.some(({ name }) => name.startsWith('strands_dev_'))).toBe(false)
    expect(await readFile(join(root, 'agent.ts'), 'utf8')).toBe(source)
  })

  it('shouldOfferTheSkillEvenWhenTheAgentTurnsSkillsOff', { timeout: 30_000 }, async () => {
    const backend = await open([])

    expect((await backend.skills.list()).map((skill) => skill.name)).toContain('create-experiment')
    expect(backend.info().tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['strands_dev_status', 'strands_dev_test'])
    )
  })

  it('shouldRunAReadOnlyToolInTheHostWithoutAskingWhenTheModelCallsIt', { timeout: 30_000 }, async () => {
    const calls: [string, JSONValue][] = []
    const backend = await open(calls)
    const asked: string[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (request) asked.push(request.toolName)
    })

    const events = await turn(backend, JSON.stringify({ tool: 'strands_dev_status', input: { verbose: true } }))
    unwatch()

    expect(calls).toEqual([['strands_dev_status', { verbose: true }]])
    expect(asked).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        status: 'success',
        content: [{ type: 'text', text: 'two experiments' }],
      })
    )
  })

  it('shouldAskFirstAndReturnTheHostErrorWhenTheModelCallsAToolThatRuns', { timeout: 30_000 }, async () => {
    const calls: [string, JSONValue][] = []
    const backend = await open(calls)
    const asked: string[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (!request) return
      asked.push(request.toolName)
      void backend.respondPermission(request.id, 'allow-once')
    })

    const events = await turn(backend, JSON.stringify({ tool: 'strands_dev_test' }))
    unwatch()

    expect(asked).toEqual(['strands_dev_test'])
    expect(calls).toEqual([['strands_dev_test', {}]])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        status: 'error',
        content: [expect.objectContaining({ text: expect.stringContaining('There is no experiment named refunds.') })],
      })
    )
  })
})
