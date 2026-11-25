import { createElement, type ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RequestSetup } from '../../src/agent/configuration.js'
import type { ChatConversation } from '../../src/agent/types.js'
import { CliConfigStore } from '../../src/config/store.js'
import { chooseHarness, WorkspaceReplacementConfirmation } from '../../src/dev/picker.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'
import * as projectWatch from '../../src/project/watch.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { ChatRoot } from '../../src/ui/app.js'
import { ChatController, type ChatControllerApi } from '../../src/ui/chat/controller.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import { FROG_INTRO_DURATION_MS } from '../../src/ui/frog-renderer.js'
import { metadataPlacements } from '../../src/ui/presentation.js'
import { runInkChat } from '../../src/ui/run.js'
import { useStartupContentRows } from '../../src/ui/startup.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { snapshot } from '../fixtures/chat-snapshot.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const STRANDS_WORDMARK = /STRANDS|▄▟[ █]{3}▙▄|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/
const INTRO_TEST_TIMEOUT_MS = 20_000

type RunOptions = NonNullable<Parameters<typeof runInkChat>[1]>
type RenderApp = NonNullable<RunOptions['renderApp']>

const workspace: DevWorkspace = {
  root: '/workspace',
  entrypoint: '/workspace/agent.ts',
  config: { version: 1, name: 'local', language: 'typescript', entrypoint: 'agent.ts', origin: { kind: 'created' } },
}

const info = {
  root: '/workspace/strands-dev',
  entrypoint: '/agents/main/agent.ts',
  boundEntrypoint: '/agents/main/agent.ts',
  origin: 'discovered',
}

const devWorkspace = {
  root: '/workspace',
  entrypoint: '/workspace/agent.ts',
  boundEntrypoint: '/workspace/agent.ts',
  origin: 'cli',
}

afterEach(() => vi.restoreAllMocks())

/** Runs the chat UI up to its startup screen; starting an agent is an error. */
const startupRun = (prepare: RunOptions['prepare'], columns = 120, rows = 35) => {
  const input = ttyInput()
  const output = ttyOutput(columns, rows)
  const frame = captureFrame(output)
  const frames: string[] = []
  output.on('data', (data: Buffer) => {
    const text = sanitizeTerminalText(data.toString())
    if (text.includes('\n') && text.trim()) frames.push(text)
  })
  const renderApp = vi.fn(render as RenderApp)
  const factory = vi.fn(async (): Promise<never> => {
    throw new Error('Unexpected agent startup')
  })
  const running = runInkChat(factory, {
    input,
    output,
    errorOutput: output,
    config: CliConfigStore.memory({}, { animations: false }),
    intro: false,
    renderApp,
    ...(prepare ? { prepare } : {}),
  })
  return { input, frame, frames, renderApp, factory, running }
}

describe('dev startup screen', () => {
  it('shouldOpenTheScreenWithTheFirstStartupCardAndKeepOneRenderer', async () => {
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const { frames, renderApp, factory, running } = startupRun(async (screen) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      screen.show(createElement(Text, {}, 'Harness selection inside the TUI'))
      await ready
      return false
    })
    try {
      await vi.waitFor(() => expect(frames.join('\n')).toContain('Harness selection inside the TUI'))

      expect(frames[0]).toContain('Harness selection inside the TUI')
      expect(frames[0]).toMatch(STRANDS_WORDMARK)
      expect(frames.join('\n')).not.toContain('/settings')
      expect(renderApp).toHaveBeenCalledOnce()
      expect(factory).not.toHaveBeenCalled()
    } finally {
      release()
      expect(await running).toBe(0)
    }
  })

  it('shouldShowTheStatusUnderTheWordmarkWhenTheFirstCardTakesLonger', async () => {
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const renderedAtShow: number[] = []
    const { frames, renderApp, running } = startupRun(async (screen) => {
      screen.show(undefined, 'Discovering local harnesses…')
      renderedAtShow.push(renderApp.mock.calls.length)
      await ready
      return false
    })
    try {
      await vi.waitFor(() => expect(frames.join('\n')).toContain('Discovering local harnesses…'))

      expect(renderedAtShow).toEqual([0])
      expect(frames[0]).toContain('Discovering local harnesses…')
      expect(frames[0]).toMatch(STRANDS_WORDMARK)
      expect(frames.join('\n')).not.toContain('/settings')
    } finally {
      release()
      expect(await running).toBe(0)
    }
  })

  it('shouldSkipTheStatusWhenTheFirstCardArrivesWithinTheStatusDelay', async () => {
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const { frames, running } = startupRun(async (screen) => {
      screen.show(undefined, 'Discovering local harnesses…')
      await new Promise((resolve) => setTimeout(resolve, 50))
      screen.show(createElement(Text, {}, 'Harness selection inside the TUI'))
      await ready
      return false
    })
    try {
      await vi.waitFor(() => expect(frames.join('\n')).toContain('Harness selection inside the TUI'))
      await new Promise((resolve) => setTimeout(resolve, 400))

      expect(frames[0]).toContain('Harness selection inside the TUI')
      expect(frames.join('\n')).not.toContain('Discovering local harnesses…')
    } finally {
      release()
      expect(await running).toBe(0)
    }
  })

  it('shouldNotOpenTheScreenWhenStartupEndsBeforeTheStatusDelay', async () => {
    const { frames, renderApp, running } = startupRun(async (screen) => {
      screen.show(undefined, 'Discovering local harnesses…')
      return false
    })

    expect(await running).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(renderApp).not.toHaveBeenCalled()
    expect(frames).toEqual([])
  })

  it('shouldDiscardKeysPressedBeforeTheFirstCardAppears', async () => {
    const received: string[] = []
    const KeyProbe = (): ReactElement => {
      useInput((value, key) => {
        received.push(key.return ? 'return' : value)
      })
      return createElement(Text, {}, 'Key probe card')
    }
    let release: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const { input, frames, running } = startupRun(async (screen) => {
      input.write('\r')
      await new Promise((resolve) => setTimeout(resolve, 50))
      screen.show(createElement(KeyProbe))
      await ready
      return false
    })
    try {
      await vi.waitFor(() => expect(frames.join('\n')).toContain('Key probe card'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(received).toEqual([])

      input.write('x')

      await vi.waitFor(() => expect(received).toEqual(['x']))
    } finally {
      release()
      expect(await running).toBe(0)
    }
  })

  it('shouldExitWhenControlCIsPressedBeforeTheFirstCardAppears', async () => {
    const { input, renderApp, running } = startupRun(async (screen) => {
      input.write('\u0003')
      await new Promise<void>((resolve) => screen.signal.addEventListener('abort', () => resolve(), { once: true }))
      return false
    })

    expect(await running).toBe(130)
    expect(renderApp).not.toHaveBeenCalled()
  })

  it('shouldKeepThePickerOpenWhenCreationFailsThenAllowRetry', async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('Model dependency could not be copied'))
      .mockResolvedValueOnce(workspace)
    let selected: DevWorkspace | undefined
    const { input, frame, running } = startupRun(async (screen) => {
      selected = await chooseHarness({ cli: { name: 'Saved CLI' }, harnesses: [] }, screen, open)
      return false
    })
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Workspace could not open.'))
      expect(frame().join('\n')).toContain('Model dependency could not be copied')
      expect(frame().join('\n')).toContain('Next:')
      expect(frame().join('\n')).toContain('Base CLI')
      input.write('\r')
      expect(await running).toBe(0)
      expect(selected).toEqual(workspace)
      expect(open).toHaveBeenCalledTimes(2)
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it('shouldKeepEveryOpenFailureLineReadableWithTheCopyHintOnAnEightyByTwentyFourScreen', async () => {
    const open = vi.fn().mockRejectedValue(new Error('Model dependency could not be copied'))
    const { input, frame, running } = startupRun(
      async (screen) => {
        await chooseHarness({ cli: { name: 'Saved CLI' }, harnesses: [] }, screen, open)
        return false
      },
      80,
      24
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error'))

      const text = frame()
        .map((line) => line.replace(/[│╭╮╰╯─]/gu, '').trim())
        .join(' ')
        .replace(/\s+/gu, ' ')
      expect(text).toContain('Workspace could not open.')
      expect(text).toContain('Reason: Model dependency could not be copied')
      expect(text).toContain('Next: Fix the reported source or configuration, then retry this workspace.')
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it.each([
    [60, 30],
    [120, 38],
    [120, 45],
  ])('shouldShowEveryPickerSectionBelowTheLogoAt%sColumnsAnd%sRows', async (columns, rows) => {
    const { input, frame, running } = startupRun(
      async (screen) => {
        await chooseHarness(
          {
            cli: { name: 'Saved CLI' },
            folderFor: () => ({ path: '/work/strands-dev', detected: true }),
            harnesses: Array.from({ length: 12 }, (_, index) => ({
              name: `Project ${index + 1}`,
              entrypoint: `/project-${index + 1}/agent.py`,
              root: `/project-${index + 1}`,
              language: 'python' as const,
            })),
          },
          screen,
          vi.fn()
        )
        return false
      },
      columns,
      rows
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      const text = frame().join('\n')
      expect(text).toContain('Base CLI')
      expect(text).toContain('Discovered Harnesses (12)')
      expect(text).toContain('Global Harness')
      expect(text).toContain('New Harness')
      expect(text).toContain('Workspace: /work/strands-dev')
      expect(text).toContain('Source:')
      expect(text).toContain('Create a new harness')
      expect(text).toMatch(/Discovered Harnesses \(12\) · 1–\d+ of 12/u)
      expect(text).not.toContain('←→')
      expect(text).toMatch(STRANDS_WORDMARK)
      expect(frame().filter((line) => line.trim()).length).toBeLessThanOrEqual(rows)
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it('shouldCancelPreparationWithoutStartingAnAgentWhenControlCIsPressed', async () => {
    let signal: AbortSignal | undefined
    const { input, frame, factory, running } = startupRun(async (screen) => {
      signal = screen.signal
      await chooseHarness({ cli: { name: 'Saved CLI' }, harnesses: [] }, screen, vi.fn())
      return false
    })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    input.write('\u0003')

    expect(await running).toBe(130)
    expect(signal?.aborted).toBe(true)
    expect(factory).not.toHaveBeenCalled()
  })

  it(
    'shouldPutTheStartupCardInPlaceAtOnceWhenAKeyIsPressedWhileItRises',
    { timeout: INTRO_TEST_TIMEOUT_MS },
    async () => {
      vi.useFakeTimers()
      const input = ttyInput()
      const output = ttyOutput(120, 40)
      const frame = captureFrame(output)
      const cardTop = (): number => frame().findIndex((line) => line.includes('╭'))
      const logo = (): string[] => frame().slice(0, 18)
      const keys: string[] = []
      const KeyProbe = (): ReactElement => {
        useInput((key) => {
          keys.push(key)
        })
        return createElement(Box, { height: useStartupContentRows() }, createElement(Text, {}, 'Choose a harness'))
      }
      const instance = render(
        createElement(ChatRoot, {
          intro: true,
          setup: false,
          setupBridge: { request: () => {}, confirmMcp: async () => true },
          onSetupComplete: () => {},
          onExitSetup: () => {},
          startupContent: createElement(KeyProbe),
        }),
        { stdin: input, stdout: output, stderr: ttyOutput(120, 40) }
      )
      try {
        await vi.advanceTimersByTimeAsync(500)
        const rising = cardTop()
        input.write('x')
        await vi.advanceTimersByTimeAsync(100)
        const fastTracked = cardTop()
        const playing = logo()
        await vi.advanceTimersByTimeAsync(FROG_INTRO_DURATION_MS)

        expect(rising).toBeGreaterThan(fastTracked)
        expect(fastTracked).toBe(cardTop())
        expect(playing).not.toEqual(logo())
        expect(keys).toEqual(['x'])
      } finally {
        instance.unmount()
        vi.useRealTimers()
      }
    }
  )

  it.each([
    ['During', FROG_INTRO_DURATION_MS / 2],
    ['After', FROG_INTRO_DURATION_MS + 500],
  ])('shouldNotReplayTheIntroWhenTheHarnessOpens%sIt', { timeout: INTRO_TEST_TIMEOUT_MS }, async (_, openAfterMs) => {
    vi.useFakeTimers()
    const input = ttyInput()
    const output = ttyOutput(120, 40)
    const frame = captureFrame(output)
    const logo = (): string[] => frame().slice(0, 18)
    const root = {
      intro: true,
      setup: false,
      setupBridge: { request: () => {}, confirmMcp: async () => true },
      onSetupComplete: () => {},
      onExitSetup: () => {},
    }
    const instance = render(
      createElement(ChatRoot, { ...root, startupContent: createElement(Text, {}, 'Choose a harness') }),
      { stdin: input, stdout: output, stderr: ttyOutput(120, 40) }
    )
    const controller = new ChatController(idleBackend())
    try {
      await vi.advanceTimersByTimeAsync(FROG_INTRO_DURATION_MS / 2)
      const playing = logo()
      await vi.advanceTimersByTimeAsync(openAfterMs - FROG_INTRO_DURATION_MS / 2)

      instance.rerender(createElement(ChatRoot, { ...root, controller }))
      await vi.advanceTimersByTimeAsync(FROG_INTRO_DURATION_MS + 500 - openAfterMs)
      const resting = logo()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(frame().join('\n')).not.toContain('Choose a harness')
      expect(resting.join('\n')).toMatch(STRANDS_WORDMARK)
      expect(resting).not.toEqual(playing)
      expect(logo()).toEqual(resting)
    } finally {
      instance.unmount()
      await controller.dispose()
      vi.useRealTimers()
    }
  })

  it('shouldKeepTheWholeConfirmationErrorReadableOnAnEightyByTwentyFourScreen', async () => {
    const { input, frame, running } = startupRun(
      async (screen) => {
        await new Promise<void>((resolve) => {
          screen.show(
            createElement(WorkspaceReplacementConfirmation, {
              directory: '/workspace/strands-dev',
              replacement: 'Other agent · /agents/other/agent.ts',
              onConfirm: resolve,
              onCancel: resolve,
            }),
            'Strands dev workspace'
          )
        })
        return false
      },
      80,
      24
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
})

describe('dev reload failures', () => {
  it('shouldKeepThePreviousAgentAndSessionWhenNewSourceCannotLoad', async () => {
    const path = '/workspace/agent.ts'
    const snapshot: ChatConversation['snapshot'] = {
      scope: 'agent',
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      data: {},
      appData: {},
    }
    const backend = idleBackend({ captureConversation: async () => snapshot })
    const previous = new ChatController(backend, {
      runtime: {
        devWorkspace: { root: '/workspace', entrypoint: path, boundEntrypoint: path, origin: 'discovered' },
        session: 'existing-session',
      },
    })
    const showError = vi.spyOn(previous, 'showError')
    const input = ttyInput()
    const output = ttyOutput(110, 35)
    let requestSetup: RequestSetup | undefined
    let attempts = 0
    const running = runInkChat(
      async (_signal, request): Promise<ChatControllerApi> => {
        requestSetup = request
        attempts += 1
        if (attempts > 1) throw new SyntaxError('Unexpected token in agent.ts\n    at source-loader')
        return previous
      },
      {
        input,
        output,
        errorOutput: output,
        config: CliConfigStore.memory(),
        intro: false,
        renderApp: render as RenderApp,
      }
    )
    try {
      await vi.waitFor(() => expect(requestSetup).toBeDefined())
      requestSetup!({ agentProject: path })
      await vi.waitFor(() => expect(showError).toHaveBeenCalledOnce())

      const [title, message] = showError.mock.calls[0]!
      expect(title).toBe('Agent reload failed')
      expect(message).toContain(`Path: ${path}`)
      expect(message).toContain('previous working agent and session are still active')
      expect(message).toContain('save again to retry')
      expect(message).not.toContain('at source-loader')
      expect(showError.mock.calls[0]![2]).toEqual({ fixDirectory: previous.getSnapshot().runtime.cwd })
      expect(previous.getSnapshot().runtime.session).toBe('existing-session')
      expect(backend.dispose).not.toHaveBeenCalled()
      expect(previous.getSnapshot().status).not.toBe('closed')
    } finally {
      input.write('\u0003')
      await running
      showError.mockRestore()
    }
  })
})

type WorkspaceActionHandler = NonNullable<RunOptions['onWorkspaceAction']>

const createController = (name: string): ChatController =>
  new ChatController(idleBackend({ name }), {
    runtime: {
      devWorkspace: {
        root: '/workspace',
        entrypoint: '/workspace/agent.ts',
        boundEntrypoint: '/workspace/agent.ts',
        origin: 'created',
      },
    },
  })

const runWithWorkspaceAction = (controller: ChatController, action: WorkspaceActionHandler) => {
  const input = ttyInput()
  const output = ttyOutput(120, 35)
  let request: RequestSetup | undefined
  const factory = vi.fn(async (_signal: AbortSignal, next: RequestSetup) => {
    request = next
    return controller
  })
  const running = runInkChat(factory, {
    input,
    output,
    errorOutput: output,
    intro: false,
    config: CliConfigStore.memory(),
    renderApp: render as RenderApp,
    onWorkspaceAction: action,
  })
  return {
    factory,
    requested: async (): Promise<RequestSetup> => {
      await vi.waitFor(() => expect(request).toBeDefined())
      return request!
    },
    stop: async (): Promise<void> => {
      input.write('\u0003')
      await running
    },
  }
}

describe('workspace actions', () => {
  it('shouldKeepTheWorkingSessionWhenTheWorkspaceActionEnds', async () => {
    const working = createController('Working agent')
    const dispose = vi.spyOn(working, 'dispose')
    const action = vi.fn<WorkspaceActionHandler>(async () => undefined)
    const run = runWithWorkspaceAction(working, action)
    try {
      ;(await run.requested())({ workspaceAction: 'edit' })

      await vi.waitFor(() => expect(action).toHaveBeenCalledOnce())
      expect(action.mock.calls[0]![0]).toBe('edit')
      expect(dispose).not.toHaveBeenCalled()
      expect(run.factory).toHaveBeenCalledOnce()
    } finally {
      await run.stop()
    }
  })

  it('shouldShowTheErrorInTheWorkingSessionWhenTheWorkspaceActionFails', async () => {
    const working = createController('Working agent')
    const show = vi.spyOn(working, 'showError')
    const run = runWithWorkspaceAction(working, async () => {
      throw new Error('Workspace editing is unavailable in this terminal.')
    })
    try {
      ;(await run.requested())({ workspaceAction: 'edit' })

      await vi.waitFor(() =>
        expect(show).toHaveBeenCalledWith('Workspace unchanged', 'Workspace editing is unavailable in this terminal.')
      )
      expect(run.factory).toHaveBeenCalledOnce()
    } finally {
      await run.stop()
    }
  })
})

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

  it('shouldOfferAutoAcceptInTheWorkspaceSectionAndSaveItAndKeepTheRowsWhenTheToggleChanges', async () => {
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
})

const session = {
  sessionId: 'saved-session',
  sessionDirectory: '/play/desk/strands-dev/.strands/state/sessions',
  workspace: '/play/desk',
  configured: { sessionId: 'saved-session', sessionDir: '/play/desk/strands-dev/.strands/state/sessions' },
}
const project = { root: '/play/desk', entrypoint: '/play/desk/desk.ts', language: 'typescript' as const }
const controller = (devWorkspace?: { entrypoint: string; boundEntrypoint: string }) =>
  new ChatController(idleBackend({ sessionIdentity: session }), {
    project,
    runtime: devWorkspace
      ? { devWorkspace: { root: '/play/desk/strands-dev', origin: 'discovered', ...devWorkspace } }
      : {},
  })

describe('dev session resume', () => {
  it('shouldResumeInTheDevWorkspaceWithoutAnAgentWhenTheSessionRanTheBoundEntrypoint', () => {
    expect(controller({ entrypoint: project.entrypoint, boundEntrypoint: project.entrypoint }).resumeSession).toEqual({
      sessionId: 'saved-session',
      sessionDirectory: session.sessionDirectory,
      workspace: '/play/desk',
      devWorkspace: '/play/desk/strands-dev',
    })
  })

  it('shouldKeepTheAgentWhenTheDevSessionRanAnotherEntrypoint', () => {
    expect(
      controller({ entrypoint: project.entrypoint, boundEntrypoint: '/play/desk/agent.ts' }).resumeSession
    ).toEqual({
      sessionId: 'saved-session',
      sessionDirectory: session.sessionDirectory,
      workspace: '/play/desk',
      devWorkspace: '/play/desk/strands-dev',
      agentProject: project.entrypoint,
    })
  })

  it('shouldResumeWithTheAgentAndNoDevWorkspaceOutsideDev', () => {
    expect(controller().resumeSession).toEqual({
      sessionId: 'saved-session',
      sessionDirectory: session.sessionDirectory,
      workspace: '/play/desk',
      agentProject: project.entrypoint,
    })
  })
})

describe('dev session identity', () => {
  it.each([
    [['src/agent.ts'], 'agent.ts'],
    [['agent.py'], 'agent.py'],
    [['a/agent.ts', 'b/agent.ts'], '2 files'],
    [[], 'agent source'],
  ] as const)('shouldDescribeTheSuccessfulReloadFor%s', async (paths, label) => {
    const controller = new ChatController(idleBackend(), { runtime: { devWorkspace } })
    try {
      controller.markReloaded(paths)
      const status = `↻ ${label} reloaded · session kept`
      expect(controller.getSnapshot().runtime.reloadStatus).toBe(status)
      expect(controller.getSnapshot().notices.at(-1)?.text).toBe(status)
      expect(
        metadataPlacements(controller.getSnapshot(), 220)
          .map(({ text }) => text)
          .join(' ')
      ).toContain(status)
    } finally {
      await controller.dispose()
    }
  })

  it('shouldIdentifyWorkspaceSettingsWhenADevControllerStarts', async () => {
    const controller = new ChatController(idleBackend({ name: 'Local harness' }), { runtime: { devWorkspace } })
    try {
      expect(controller.getSnapshot().notices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining('Model, tools, and instructions come from this workspace'),
          }),
        ])
      )
      expect(controller.getSnapshot().notices[0]?.text).toContain('/workspace/agent.ts')
      expect(controller.getSnapshot().notices[0]?.text).not.toContain('not the saved CLI profile')
    } finally {
      await controller.dispose()
    }
  })

  it.each([true, false])('shouldShowRealWatchStatusWhenWatchingIs%s', (watching) => {
    const value = snapshot()
    value.runtime.devWorkspace = devWorkspace
    value.runtime.agent = 'Local harness'
    value.runtime.sourceWatching = watching

    const footer = metadataPlacements(value, 220)
      .map(({ text }) => text)
      .join(' ')

    expect(footer).toContain('dev · Local harness')
    expect(footer).toContain(watching ? 'watching files' : 'watch off')
  })

  it('shouldClearWatchStatusWhenTheWatcherFails', async () => {
    let fail: (error: Error) => void = () => undefined
    vi.spyOn(projectWatch, 'watchAgentProject').mockImplementation((_project, _changed, failed) => {
      fail = failed
      return () => undefined
    })
    const controller = new ChatController(idleBackend(), { runtime: { devWorkspace } })
    const manager = new ConversationManager(controller, {
      fork: async () => controller,
      project: { root: '/workspace', entrypoint: '/workspace/agent.ts', language: 'typescript' },
      projectPrivatePaths: [],
      reloadProject: () => undefined,
    })
    try {
      expect(manager.getSnapshot().runtime.sourceWatching).toBe(true)

      manager.markReloaded(['agent.ts'])
      expect(manager.getSnapshot().runtime.reloadStatus).toContain('session kept')
      fail(new Error('watch failed'))

      expect(manager.getSnapshot().runtime.sourceWatching).toBe(false)
      expect(manager.getSnapshot().runtime.reloadStatus).toBeUndefined()
    } finally {
      await manager.dispose()
    }
  })

  it('shouldKeepOrdinarySessionsUnchangedWhenNoWorkspaceIsSelected', async () => {
    const controller = new ChatController(idleBackend())
    try {
      expect(controller.getSnapshot().runtime.devWorkspace).toBeUndefined()
      expect(controller.getSnapshot().notices).toEqual([])
    } finally {
      await controller.dispose()
    }
  })
})
