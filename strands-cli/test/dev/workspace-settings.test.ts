import { createElement } from 'react'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import { openWorkspaceConfiguration } from '../../src/dev/prepare.js'
import { WorkspaceReplacementConfirmation } from '../../src/dev/picker.js'
import { runInkChat } from '../../src/ui/run.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import * as terminal from '../../src/terminal/terminal.js'

const info = {
  root: '/workspace/strands-dev',
  entrypoint: '/agents/main/agent.ts',
  boundEntrypoint: '/agents/main/agent.ts',
  origin: 'discovered',
}

const project = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(root, 'agent.ts'),
    "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Agent' })\n"
  )
  return join(root, 'agent.ts')
}

describe('workspace Settings', () => {
  it('shouldShowWorkspaceActionsOnlyWhenTheSessionRunsInDev', async () => {
    const action = vi.fn()
    const dev = new ChatController(idleBackend(), { runtime: { devWorkspace: info }, workspaceAction: action })
    const normal = new ChatController(idleBackend(), { workspaceAction: action })
    try {
      await dev.submit('/settings')
      expect(dev.getSnapshot().panel?.filters).toContainEqual({
        id: 'settings:Workspace',
        label: 'Strands dev workspace',
      })
      await dev.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })
      expect(dev.getSnapshot().panel?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Workspace folder', description: info.root }),
          expect.objectContaining({ value: 'workspace:edit' }),
        ])
      )
      expect(dev.getSnapshot().panel?.rows.some(({ value }) => value === 'workspace:create')).toBe(false)
      expect(await dev.activatePanelRow({ label: '', description: '', value: 'workspace:create' })).toBe(false)
      await dev.activatePanelRow({ label: '', description: '', value: 'workspace:edit' })
      expect(action).toHaveBeenCalledExactlyOnceWith('edit')
      await normal.submit('/settings')
      expect(normal.getSnapshot().panel?.filters?.some(({ id }) => id === 'settings:Workspace')).toBe(false)
      expect(await normal.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })).toBe(false)
    } finally {
      await dev.dispose()
      await normal.dispose()
    }
  })

  it('shouldOfferAutoAcceptInTheWorkspaceSectionAndSaveItWhenTheToggleChanges', async () => {
    const setSettings = vi.fn(async () => undefined)
    const dev = new ChatController(idleBackend(), {
      runtime: { devWorkspace: info },
      workspaceAction: vi.fn(),
      setSettings,
    })
    try {
      await dev.submit('/settings')
      await dev.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })
      const toggle = () => dev.getSnapshot().panel?.rows.find(({ value }) => value === 'autoAcceptOptimizationResults')
      expect(toggle()).toMatchObject({ label: 'Auto-accept optimization results', control: { checked: false } })
      expect(dev.getSnapshot().panel?.rows.find(({ value }) => value === 'autoOptimize')).toMatchObject({
        label: 'Auto-optimize every N turns',
        control: { kind: 'segmented', options: expect.arrayContaining([{ label: 'Off', value: '0', active: true }]) },
      })

      await dev.activatePanelRow(toggle()!)

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoAcceptOptimizationResults: true })
      expect(toggle()).toMatchObject({ control: { checked: true } })
    } finally {
      await dev.dispose()
    }
  })

  it('shouldKeepTheWorkspaceRowsWhenTheAutoAcceptToggleChanges', async () => {
    const setSettings = vi.fn(async () => undefined)
    const dev = new ChatController(idleBackend(), {
      runtime: { devWorkspace: info },
      workspaceAction: vi.fn(),
      setSettings,
    })
    try {
      await dev.submit('/settings')
      await dev.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })
      const toggle = () => dev.getSnapshot().panel?.rows.find(({ value }) => value === 'autoAcceptOptimizationResults')
      expect(toggle()).toMatchObject({ label: 'Auto-accept optimization results', control: { checked: false } })

      await dev.activatePanelRow(toggle()!)

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoAcceptOptimizationResults: true })
      expect(toggle()).toMatchObject({ control: { checked: true } })
      expect(dev.getSnapshot().panel?.rows).toContainEqual(expect.objectContaining({ value: 'workspace:edit' }))
    } finally {
      await dev.dispose()
    }
  })

  it('shouldNotOfferTheImportOfADifferentAgentWhenTheWorkspaceSectionOpens', async () => {
    const action = vi.fn()
    const dev = new ChatController(idleBackend(), { runtime: { devWorkspace: info }, workspaceAction: action })
    try {
      await dev.submit('/settings')
      await dev.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })

      expect(dev.getSnapshot().panel?.rows.map(({ label }) => label)).not.toContain('Import a different agent')
      expect(await dev.activatePanelRow({ label: '', description: '', value: 'workspace:import' })).toBe(false)
      expect(action).not.toHaveBeenCalled()
    } finally {
      await dev.dispose()
    }
  })

  it('shouldNotTypeTheMouseReportsOfTheTerminalIntoTheConfirmation', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const confirm = vi.fn()
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'Other agent · /agents/other/agent.ts',
        onConfirm: confirm,
        onCancel: vi.fn(),
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))

    input.write('DEL')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DEL▏'))
    input.write(mouseInputSequence(64, 49, 19, 'M') + mouseInputSequence(35, 49, 19, 'M'))
    input.write('ETE')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DELETE▏'))
    input.write('\r')

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  })

  it('shouldRequireTypedDeleteBeforeConfirmingTheReplacement', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const confirm = vi.fn()
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'Other agent · /agents/other/agent.ts',
        onConfirm: confirm,
        onCancel: cancel,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
    expect(frame().join('\n')).toContain(info.root)
    expect(frame().join('\n')).toContain('All files in this folder will be replaced')
    expect(frame().join('\n')).toContain('outside this folder will not be deleted')
    expect(frame().join('\n')).toContain('Replacement: Other agent · /agents/other/agent.ts')
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Type DELETE exactly'))
    expect(confirm).not.toHaveBeenCalled()
    input.write('DELETE')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DELETE'))
    input.write('\r')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shouldCopyTheConfirmationErrorWithoutTypingIntoTheApprovalWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'Other agent · /agents/other/agent.ts',
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
    input.write('DEL')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DEL▏'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Enter confirm · Ctrl+Y copy error · Esc back'))

    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0]![0]).toBe('Type DELETE exactly to confirm, or press Esc to select a different agent.')
    expect(frame().join('\n')).toContain('confirm: DEL▏')
    copy.mockRestore()
  })

  it('shouldKeepTheWholeConfirmationErrorReadableOnAnEightyByTwentyFourScreen', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const frame = captureFrame(output)
    const running = runInkChat(
      async (): Promise<never> => {
        throw new Error('Unexpected agent startup')
      },
      {
        input,
        output,
        errorOutput: output,
        intro: false,
        config: CliConfigStore.memory({}, { animations: false }),
        renderApp: render as NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>,
        prepare: async (screen) => {
          await new Promise<void>((resolve) => {
            screen.show(
              createElement(WorkspaceReplacementConfirmation, {
                directory: info.root,
                replacement: 'Other agent · /agents/other/agent.ts',
                onConfirm: resolve,
                onCancel: resolve,
              }),
              'Strands dev workspace'
            )
          })
          return false
        },
      }
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error'))

      const text = frame()
        .map((line) => line.replace(/[│╭╮╰╯─]/gu, '').trim())
        .join(' ')
        .replace(/\s+/gu, ' ')
      expect(text).toContain('Type DELETE exactly to confirm, or press Esc to select a different agent.')
      expect(text).toContain('Enter confirm · Ctrl+Y copy error · Esc back')
    } finally {
      input.write('\u001b')
      await running
    }
  })

  it('shouldGoBackWithoutConfirmingWhenEscapeIsPressed', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const confirm = vi.fn()
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'New typescript agent · new-harness',
        onConfirm: confirm,
        onCancel: cancel,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('DELETE workspace and replace?'))
    input.write('\u001b')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('workspace configuration from Settings', () => {
  beforeEach(async () => {
    const home = await realpath(await temporaryDirectory())
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const screen = (openProject?: () => Promise<void>) => ({
    signal: new AbortController().signal,
    show: vi.fn(),
    ...(openProject ? { openProject } : {}),
  })

  it('shouldOpenTheConfigOfTheActiveWorkspaceWhenEditIsChosen', async () => {
    const launch = await realpath(await temporaryDirectory())
    const directory = join(launch, 'strands-dev')
    await mkdir(directory)
    await bindExistingAgent(directory, await project(join(launch, 'agent')))
    const openProject = vi.fn(async () => undefined)

    await openWorkspaceConfiguration(parseArgs(['dev', '--workspace', directory]), screen(openProject))

    expect(openProject).toHaveBeenCalledExactlyOnceWith({ root: directory, entrypoint: join(directory, '.config') })
  })

  it('shouldRefuseToEditWhenNoDevWorkspaceIsActive', async () => {
    await expect(openWorkspaceConfiguration(parseArgs(['dev']), screen())).rejects.toThrow(
      'No dev workspace is active.'
    )
  })
})
