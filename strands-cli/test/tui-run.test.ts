import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, type Instance } from 'ink'
import { Message, TextBlock } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type ChatBackend,
  type ChatControllerApi,
  type ChatConversation,
  type ChatConversations,
  type ChatEvent,
  type ChatRunResult,
} from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { configurationFromStore, type RequestSetup, type SetupChange } from '../src/tui/agent-configuration.js'
import { runInkChat } from '../src/tui/run.js'
import * as processTree from '../src/tui/terminal/process-tree.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { workspaceSessionDirectory } from '../src/tui/session/catalog.js'
import { PythonVoiceSession } from '../src/tui/voice/session.js'

function backend(): ChatBackend {
  return {
    id: 'test',
    name: 'Test',
    protocol: 'strands',
    async *stream(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      yield* []
      return { stopReason: 'endTurn' }
    },
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
}

describe('runInkChat', () => {
  it.each([
    { exitCode: 0, saved: true },
    { exitCode: 130, saved: true },
    { exitCode: 0, saved: false },
  ])('restores the terminal before resume advice on exit ($exitCode, saved=$saved)', async ({ exitCode, saved }) => {
    const target = backend()
    const controller = new ChatController(target)
    controller.close(exitCode)
    if (saved) {
      Object.defineProperty(controller, 'resumeSession', {
        value: {
          sessionId: 'saved-session',
          sessionDirectory: workspaceSessionDirectory(process.cwd()),
          workspace: process.cwd(),
        },
      })
    }
    const writes: string[] = []
    const output = {
      write: (value: string, callback?: () => void) => {
        writes.push(value)
        callback?.()
        return true
      },
    } as unknown as NodeJS.WriteStream
    const unmount = vi.fn()
    const cleanup = vi.fn()
    const instance = {
      unmount,
      cleanup,
      waitUntilExit: async () => {},
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance
    const renderApp = vi.fn((_element: unknown) => instance)
    const sigintListeners = process.listenerCount('SIGINT')

    const result = await runInkChat(controller, {
      output,
      renderApp: renderApp as never,
      input: process.stdin,
      errorOutput: process.stderr,
      intro: false,
    })

    expect(result).toBe(exitCode)
    expect(writes[0]).toContain('?1049h')
    const outputText = writes.join('')
    if (saved) {
      expect(writes.at(-1)).toBe('\nResume with: strands --session-id saved-session\n')
      expect(outputText.indexOf('?1049l')).toBeLessThan(outputText.indexOf('Resume with:'))
    } else {
      expect(writes.at(-1)).toContain('?1049l')
      expect(outputText).not.toContain('Resume with:')
    }
    expect(unmount).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(target.dispose).toHaveBeenCalledOnce()
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners)
  })

  it('waits for resume advice to flush before forcing an interrupted session to exit', async () => {
    const controller = new ChatController(backend())
    controller.close(130)
    Object.defineProperty(controller, 'resumeSession', {
      value: {
        sessionId: 'interrupted-session',
        sessionDirectory: workspaceSessionDirectory(process.cwd()),
        workspace: process.cwd(),
      },
    })
    const writes: string[] = []
    let finishWrite: (() => void) | undefined
    const output = {
      write: (value: string, callback?: () => void) => {
        writes.push(value)
        if (callback) finishWrite = callback
        return true
      },
    } as unknown as NodeJS.WriteStream
    const stopped = new Error('process exited')
    vi.spyOn(controller, 'hardExitCode', 'get').mockReturnValue(130)
    const hardExit = vi.spyOn(processTree, 'hardExitProcessTree').mockImplementation(() => {
      expect(writes.join('')).toContain('?1049l')
      expect(writes.join('')).toContain('Resume with: strands --session-id interrupted-session')
      throw stopped
    })
    try {
      const exited = expect(
        runInkChat(controller, {
          output,
          intro: false,
          renderApp: (() => ({
            unmount: vi.fn(),
            cleanup: vi.fn(),
            waitUntilExit: async () => {},
            rerender: vi.fn(),
            clear: vi.fn(),
          })) as never,
        })
      ).rejects.toThrow(stopped)
      await vi.waitFor(() => expect(finishWrite).toBeDefined())
      expect(hardExit).not.toHaveBeenCalled()
      finishWrite!()
      await exited
      expect(hardExit).toHaveBeenCalledExactlyOnceWith(130)
    } finally {
      hardExit.mockRestore()
    }
  })

  it('returns the requested exit code while a replacement is starting', async () => {
    const snapshot: ChatConversation['snapshot'] = {
      scope: 'agent',
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      data: {},
      appData: {},
    }
    const previous = new ChatController({ ...backend(), captureConversation: async () => snapshot })
    const replacement = new ChatController(backend())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = vi.fn(async (): Promise<ChatControllerApi> => {
      if (source.mock.calls.length === 1) return previous
      await gate
      return replacement
    })
    let finish!: () => void
    let root!: {
      props: {
        onSetupComplete(code: 0, changed: boolean): void
        onCancelStartup(): void
        controller?: ChatControllerApi
      }
    }
    const instance = {
      unmount: vi.fn(() => finish?.()),
      cleanup: vi.fn(),
      clear: vi.fn(),
      waitUntilExit: () => new Promise<void>((resolve) => (finish = resolve)),
      rerender: (element: unknown) => {
        root = element as typeof root
      },
    } as unknown as Instance
    const running = runInkChat(source, {
      alternateScreen: false,
      errorOutput: new PassThrough() as unknown as NodeJS.WriteStream,
      renderApp: ((element: unknown) => {
        root = element as typeof root
        return instance
      }) as never,
    })
    try {
      await vi.waitFor(() => expect(finish).toBeDefined())
      root.props.onSetupComplete(0, true)
      await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(2))
      root.props.onCancelStartup()
      release()
      await expect(running).resolves.toBe(130)
    } finally {
      release()
      instance.unmount()
      await running
    }
  })

  it('cancels initial setup without waiting for its completion', async () => {
    const source = vi.fn(async () => new ChatController(backend()))
    let root!: { props: { onCancelStartup(): void; onSetupComplete(exitCode: 0 | 130, changed: boolean): void } }
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: async () => {},
      rerender: vi.fn(),
    } as unknown as Instance
    let exitCode: number | undefined
    const running = runInkChat(source, {
      alternateScreen: false,
      setup: true,
      config: CliConfigStore.memory(),
      renderApp: ((element: unknown) => {
        root = element as typeof root
        return instance
      }) as never,
    }).then((result) => {
      exitCode = result
    })

    try {
      await vi.waitFor(() => expect(root).toBeDefined())
      root.props.onCancelStartup()
      await vi.waitFor(() => expect(exitCode).toBe(130))
      expect(source).not.toHaveBeenCalled()
      expect(instance.cleanup).toHaveBeenCalledOnce()
    } finally {
      root.props.onSetupComplete(130, false)
      await running
    }
  })

  it('retains chat on reload or failed setup', async () => {
    const config = CliConfigStore.memory(
      {},
      { toolOutput: 'full', animations: false, showReasoning: false, frogTheme: 'merlin' },
      { onboardingVersion: 0, profile: { name: 'Original' } }
    )
    const messages = [new Message({ role: 'user', content: [new TextBlock('Remember the blue frog.')] })]
    const snapshot: ChatConversation['snapshot'] = {
      scope: 'agent',
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      data: { messages: [{ role: 'user', content: [{ text: 'Remember the blue frog.' }] }] },
      appData: {},
    }
    const session: NonNullable<ChatConversation['session']> = {
      sessionId: 'portable-session',
      sessionDirectory: '/tmp/sessions',
      workspace: '/tmp/workspace',
      configured: { sessionId: null, sessionDir: '.agent/sessions' },
    }
    const sourceSelection: NonNullable<ChatConversation['sourceSelection']> = {
      source: '/tmp/agent.ts',
      configured: { model: 'bedrock/authored', thinking: 'off' },
      selected: { model: 'bedrock/selected', thinking: 'high' },
    }
    const previousBackend = {
      ...backend(),
      captureConversation: async () => snapshot,
      sessionIdentity: session,
      sourceSelection: () => sourceSelection,
    }
    const previousController = new ChatController(previousBackend, { initialMessages: messages })
    const previous = new ConversationManager(previousController, { fork: async () => previousController })
    let current = previous
    const source = vi.fn(async (_signal: AbortSignal, _setup: () => void, conversation?: ChatConversations) => {
      if (!conversation) return previous
      expect(previousBackend.dispose).not.toHaveBeenCalled()
      const replacement = new ChatController(
        { ...backend(), name: 'Customized Strands harness', captureConversation: async () => snapshot },
        { initialTurns: conversation.entries.at(-1)!.conversation.completedTurns }
      )
      current = new ConversationManager(replacement, { fork: async () => replacement })
      return current
    })
    let finish!: () => void
    let root!: {
      props: { onSetupComplete(code: 0, changed: boolean, change?: SetupChange): void; controller?: ChatController }
    }
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
      waitUntilExit: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      rerender: (element: unknown) => {
        root = element as typeof root
      },
    } as unknown as Instance
    const running = runInkChat(source, {
      config,
      intro: false,
      alternateScreen: false,
      errorOutput: new PassThrough() as unknown as NodeJS.WriteStream,
      renderApp: ((element: unknown) => {
        root = element as typeof root
        return instance
      }) as never,
    })
    try {
      await vi.waitFor(() => expect(finish).toBeDefined())
      root.props.onSetupComplete(0, false)
      expect(source).toHaveBeenCalledOnce()
      root.props.onSetupComplete(0, true)
      await vi.waitFor(() => expect(previousBackend.dispose).toHaveBeenCalledOnce())
      expect(current.getSnapshot().completedTurns).toEqual(previous.getSnapshot().completedTurns)
      expect(source.mock.calls[1]?.[2]?.entries[0]?.conversation.snapshot).toEqual(snapshot)
      expect(source.mock.calls[1]?.[2]?.entries[0]?.conversation.session).toEqual(session)
      expect(source.mock.calls[1]?.[2]?.entries[0]?.conversation.sourceSelection).toEqual(sourceSelection)
      source.mockRejectedValueOnce(new Error('Invalid configuration'))
      const before = configurationFromStore(config)
      root.props.onSetupComplete(0, true, {
        configuration: {
          ...before,
          profile: { ...before.profile, name: 'Invalid' },
          settings: {
            ...before.settings,
            toolOutput: 'hidden',
            animations: true,
            showReasoning: true,
            frogTheme: 'green',
          },
        },
      })
      await vi.waitFor(() => expect(current.getSnapshot().panel?.title).toBe('Setup failed'))
      expect(configurationFromStore(config)).toEqual(before)
      expect(config.needsSetup()).toBe(true)
      expect(root.props.controller).toBe(current)
      expect(current.getSnapshot().completedTurns[0]?.prompt).toBe('Remember the blue frog.')
      current.dismissPanel()
      await current.submit('Continue.')
      expect(current.getSnapshot().completedTurns).toHaveLength(2)
    } finally {
      finish()
      await running
    }
  })

  it.each([false, true])(
    'preserves the applying conversation and rejects voice during reload (failure=%s)',
    async (fails) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-setup-'))
      const configPath = join(directory, 'cli.toml')
      const config = await CliConfigStore.load(configPath)
      await config.saveSetup(configurationFromStore(config))
      const saved = await readFile(configPath, 'utf8')
      const configuration = {
        ...configurationFromStore(config),
        profile: { ...config.snapshot().profile, name: 'Replacement' },
      }
      const agentProject = join(directory, 'agent.ts')
      const snapshot: ChatConversation['snapshot'] = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: new Date().toISOString(),
        data: {},
        appData: {},
      }
      const primary = new ChatController({ ...backend(), captureConversation: async () => snapshot })
      const fork = new ChatController({ ...backend(), captureConversation: async () => snapshot })
      const voice = new PythonVoiceSession()
      let requestVoice!: Parameters<PythonVoiceSession['onSupervisorRequest']>[0]
      const resolveVoice = vi.spyOn(voice, 'resolveSupervisorRequest').mockReturnValue(true)
      vi.spyOn(voice, 'onSupervisorRequest').mockImplementation((listener) => {
        requestVoice = listener
        return () => {}
      })
      const previous = new ConversationManager(primary, { fork: async () => fork, voice })
      let finishDisposal!: () => void
      const disposal = new Promise<void>((resolve) => {
        finishDisposal = resolve
      })
      const dispose = previous.dispose.bind(previous)
      vi.spyOn(previous, 'dispose').mockImplementation(async () => {
        await dispose()
        await disposal
      })
      await previous.submit('Primary history')
      await previous.submit('/fork')
      await previous.submit('Fork history')
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let requestSetup!: RequestSetup
      let captured: ChatConversations | undefined
      let replacement: ChatController | undefined
      const onFailure = vi.fn(async () => {})
      const source = async (
        _signal: AbortSignal,
        setup: RequestSetup,
        conversation?: ChatConversations
      ): Promise<ChatControllerApi> => {
        requestSetup = setup
        if (!conversation) return previous
        captured = conversation
        await gate
        if (fails) throw new Error('Replacement failed')
        replacement = new ChatController(backend(), {
          initialTurns: conversation.entries.at(-1)!.conversation.completedTurns,
        })
        return replacement
      }
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn(),
        ref: vi.fn(),
        unref: vi.fn(),
      }) as unknown as NodeJS.ReadStream
      const output = Object.assign(new PassThrough(), {
        isTTY: true,
        columns: 100,
        rows: 30,
      }) as unknown as NodeJS.WriteStream
      let rendered = ''
      output.on('data', (chunk: Buffer) => {
        rendered += chunk.toString()
      })
      let instance!: Instance
      const running = runInkChat(source, {
        config,
        intro: false,
        alternateScreen: false,
        input,
        output,
        errorOutput: output,
        renderApp: (element, options) => {
          instance = render(element, { ...options, interactive: true, patchConsole: false })
          return instance
        },
      })
      try {
        await vi.waitFor(() => expect(rendered).toContain('Fork history'))
        requestSetup({ conversationId: 'agent-1', configuration, agentProject, onFailure })
        await vi.waitFor(() => expect(captured).toBeDefined())
        expect(config.snapshot().profile.name).toBe('Replacement')
        expect(config.snapshot().agentProject).toBe(agentProject)
        expect(await readFile(configPath, 'utf8')).toBe(saved)
        expect(captured!.activeId).toBe('agent-2')
        expect(captured!.entries.map((entry) => entry.conversation.completedTurns.map((turn) => turn.prompt))).toEqual([
          ['Primary history'],
          ['Fork history'],
        ])
        const utterances = ['Voice one', 'Voice two']
        for (const utterance of utterances) {
          requestVoice({ requestId: utterance, action: 'send_instruction', instruction: utterance })
          expect(resolveVoice).toHaveBeenCalledWith(utterance, {
            ok: false,
            error: expect.stringContaining('reloading'),
          })
        }
        expect(primary.getSnapshot().completedTurns).toHaveLength(1)
        expect(fork.getSnapshot().completedTurns).toHaveLength(1)
        rendered = ''
        release()
        if (!fails) {
          await vi.waitFor(() => expect(previous.dispose).toHaveBeenCalledOnce())
          await instance.waitUntilRenderFlush()
          expect(rendered).not.toContain('Primary history')
          finishDisposal()
        }
        await vi.waitFor(() => {
          const active = fails ? previous : replacement
          expect(active?.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual(['Fork history'])
          expect(active?.getSnapshot().completedTurns.every((turn) => turn.status === 'complete')).toBe(true)
        })
        const reloaded = (await CliConfigStore.load(configPath)).snapshot()
        expect(reloaded).toEqual(config.snapshot())
        expect(reloaded.profile.name).toBe(fails ? 'Strands harness' : 'Replacement')
        expect(reloaded.agentProject).toBe(fails ? undefined : agentProject)
        if (fails) {
          expect(await readFile(configPath, 'utf8')).toBe(saved)
          expect(onFailure).toHaveBeenCalledExactlyOnceWith('Replacement failed')
        } else {
          expect(onFailure).not.toHaveBeenCalled()
        }
      } finally {
        release()
        finishDisposal()
        instance.unmount()
        await running
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('restores the alternate screen and removes signal listeners after a normal exit', async () => {
    const target = backend()
    const controller = new ChatController(target)
    controller.close(0)
    const writes: string[] = []
    const output = { write: (value: string) => writes.push(value) } as unknown as NodeJS.WriteStream
    const unmount = vi.fn()
    const cleanup = vi.fn()
    const instance = {
      unmount,
      cleanup,
      waitUntilExit: async () => {},
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance
    const renderApp = vi.fn((_element: unknown) => instance)
    const sigintListeners = process.listenerCount('SIGINT')

    const exitCode = await runInkChat(controller, {
      output,
      renderApp: renderApp as never,
      input: process.stdin,
      errorOutput: process.stderr,
      intro: false,
    })

    expect(exitCode).toBe(0)
    expect(writes[0]).toContain('?1049h')
    expect(writes.at(-1)).toContain('?1049l')
    expect(unmount).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(target.dispose).toHaveBeenCalledOnce()
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners)
  })

  it('restores the terminal when Ink fails to mount', async () => {
    const controller = new ChatController(backend())
    const writes: string[] = []
    const output = { write: (value: string) => writes.push(value) } as unknown as NodeJS.WriteStream

    await expect(
      runInkChat(controller, {
        output,
        intro: false,
        renderApp: (() => {
          throw new Error('render failed')
        }) as never,
      })
    ).rejects.toThrow('render failed')
    expect(writes.at(-1)).toContain('?1049l')
  })

  it('cancels startup MCP trust with Ctrl-C and restores the terminal before forced exit', async () => {
    const forcedExit = new Error('forced startup exit')
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    }) as unknown as NodeJS.ReadStream
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 })
    let written = ''
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString()
    })
    const sigintListeners = process.listenerCount('SIGINT')
    const hardExit = vi.spyOn(processTree, 'hardExitProcessTree').mockImplementation(() => {
      expect(input.setRawMode).toHaveBeenLastCalledWith(false)
      expect(written).toContain('?1049l')
      throw forcedExit
    })
    let startupSignal: AbortSignal | undefined
    const running = runInkChat(
      async (signal, _setup, _conversation, _launch, confirmMcp) => {
        startupSignal = signal
        await confirmMcp('/workspace', ['mcp.json'])
        throw new Error('trust declined')
      },
      {
        input,
        output: output as unknown as NodeJS.WriteStream,
        errorOutput: output as unknown as NodeJS.WriteStream,
        renderApp: (element, options) => render(element, { ...options, interactive: true, patchConsole: false }),
      }
    ).catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(written).toContain("Trust this project's MCP configuration?"))
      input.push('\u0003')
      await vi.waitFor(() => expect(startupSignal?.aborted).toBe(true))
      expect(await running).toBe(forcedExit)
      expect(hardExit).toHaveBeenCalledExactlyOnceWith(130)
      // The invariant we own is that runInkChat removes its own SIGINT handler. Counting all listeners is
      // not portable: on Windows, ink's cursor handling makes restore-cursor install a permanent signal-exit hook.
      await vi.waitFor(() => {
        const sources = process.listeners('SIGINT').map((listener) => listener.toString())
        expect(sources.filter((source) => source.includes('closeForExit'))).toEqual([])
        expect(sources.length).toBeGreaterThanOrEqual(sigintListeners)
      })
    } finally {
      if (!startupSignal?.aborted) input.push('n')
      await running
      hardExit.mockRestore()
      input.destroy()
      output.destroy()
    }
  })

  it('renders startup before constructing the controller', async () => {
    const controller = new ChatController(backend())
    controller.close(0)
    const writes: string[] = []
    const output = { write: (value: string) => writes.push(value) } as unknown as NodeJS.WriteStream
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: async () => {},
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance
    const renderApp = vi.fn((_element: unknown) => {
      expect(writes[0]).toContain('?1049h')
      return instance
    })
    const source = vi.fn(async () => {
      expect(writes[0]).toContain('?1049h')
      expect(renderApp).toHaveBeenCalledOnce()
      return controller
    })

    await runInkChat(source, {
      output,
      intro: false,
      renderApp: renderApp as never,
    })

    expect(renderApp).toHaveBeenCalledOnce()
    expect(renderApp.mock.invocationCallOrder[0]).toBeLessThan(source.mock.invocationCallOrder[0]!)
    expect(instance.rerender).toHaveBeenCalledOnce()
    expect(writes.at(-1)).toContain('?1049l')
  })

  it('renders and starts the first request when the controller is ready without waiting for the intro', async () => {
    const controller = new ChatController(backend())
    const start = vi.spyOn(controller, 'start')
    let resolveController!: (value: ChatController) => void
    const controllerTask = new Promise<ChatController>((resolve) => {
      resolveController = resolve
    })
    let renderedRoot: unknown
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: async () => {},
      rerender: vi.fn((element: unknown) => {
        renderedRoot = element
      }),
      clear: vi.fn(),
    } as unknown as Instance
    const renderApp = vi.fn((element: unknown) => {
      renderedRoot = element
      return instance
    })

    const source = vi.fn(() => controllerTask)
    const runTask = runInkChat(source, {
      alternateScreen: false,
      firstRequest: 'hello',
      renderApp: renderApp as never,
    })

    try {
      await vi.waitFor(() => expect(source).toHaveBeenCalledOnce())
      expect(renderApp).toHaveBeenCalledOnce()
      expect(start).not.toHaveBeenCalled()
    } finally {
      resolveController(controller)
      await runTask
    }
    expect(renderApp).toHaveBeenCalledOnce()
    expect(instance.rerender).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledExactlyOnceWith('hello')
    expect(renderApp.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)
    const root = renderedRoot as {
      props: { controller: ChatController; intro: boolean }
    }
    expect(root.props.controller).toBe(controller)
    expect(root.props.intro).toBe(true)
  })

  it('renders explicitly requested setup and waits for its completion before constructing the controller', async () => {
    const controller = new ChatController(backend())
    controller.close(0)
    const source = vi.fn(async () => controller)
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: async () => {},
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance
    let renderedRoot: unknown
    const runTask = runInkChat(source, {
      alternateScreen: false,
      setup: true,
      config: CliConfigStore.memory({}, {}, { onboardingVersion: 0 }),
      renderApp: ((element: unknown) => {
        renderedRoot = element
        return instance
      }) as never,
    })

    await vi.waitFor(() => expect(renderedRoot).toBeDefined())
    expect(source).not.toHaveBeenCalled()
    const root = renderedRoot as {
      props: {
        intro: boolean
        setup: boolean
        onSetupComplete(exitCode: 0 | 130, changed: boolean): void
      }
    }
    expect(root.props.intro).toBe(true)
    expect(root.props.setup).toBe(true)
    root.props.onSetupComplete(0, false)
    await runTask

    expect(source).toHaveBeenCalledOnce()
  })
})

describe('conversation portability', () => {
  it('refuses to fork a source that cannot reconstruct its agent', async () => {
    const primary = new ChatController({ ...backend(), reconstructable: () => false })
    const fork = vi.fn(async () => new ChatController(backend()))
    const conversations = new ConversationManager(primary, { fork })

    try {
      await conversations.submit('/fork')
      expect(conversations.getSnapshot().panel).toMatchObject({
        kind: 'error',
        title: 'fork unavailable',
        rows: [expect.objectContaining({ description: expect.stringContaining('reconstructable agent factory') })],
      })
      expect(fork).not.toHaveBeenCalled()
    } finally {
      await conversations.dispose()
    }
  })
})
