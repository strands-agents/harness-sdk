import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { render, renderToString, type Instance } from 'ink'
import { Message, TextBlock } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type ChatBackend,
  type ChatControllerApi,
  type ChatConversation,
  type ChatEvent,
  type ChatRunResult,
} from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { configurationFromStore, type RequestSetup, type SetupChange } from '../src/tui/agent-configuration.js'
import { runInkChat } from '../src/tui/run.js'
import { ConversationManager } from '../src/tui/session/conversations.js'
import { PythonVoiceSession } from '../src/tui/voice/session.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ChatView } from '../src/tui/view/chat-view.js'

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
    const previous = new ChatController(previousBackend, { initialMessages: messages })
    let current = previous
    const source = vi.fn(async (_signal: AbortSignal, _setup: () => void, conversation?: ChatConversation) => {
      if (!conversation) return previous
      expect(previousBackend.dispose).not.toHaveBeenCalled()
      current = new ChatController(
        { ...backend(), name: 'Customized Strands harness', captureConversation: async () => snapshot },
        { initialTurns: conversation.completedTurns }
      )
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
      expect(source.mock.calls[1]?.[2]?.snapshot).toEqual(snapshot)
      expect(source.mock.calls[1]?.[2]?.session).toEqual(session)
      expect(source.mock.calls[1]?.[2]?.sourceSelection).toEqual(sourceSelection)
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
    'preserves the applying conversation and buffers voice during reload (failure=%s)',
    async (fails) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-setup-'))
      const configPath = join(directory, 'config.json')
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
      let transcript!: (text: string) => void
      vi.spyOn(voice, 'onTranscript').mockImplementation((listener) => {
        transcript = listener
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
      let captured: ChatConversation | undefined
      let replacement: ChatController | undefined
      const onFailure = vi.fn(async () => {})
      const source = async (
        _signal: AbortSignal,
        setup: RequestSetup,
        conversation?: ChatConversation
      ): Promise<ChatControllerApi> => {
        requestSetup = setup
        if (!conversation) return previous
        captured = conversation
        await gate
        if (fails) throw new Error('Replacement failed')
        replacement = new ChatController(backend(), { initialTurns: conversation.completedTurns })
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
        expect(captured!.completedTurns.map((turn) => turn.prompt)).toEqual(['Primary history'])
        const utterances = ['Voice one', 'Voice two']
        for (const utterance of utterances) transcript(utterance)
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
          expect(active?.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual([
            fails ? 'Fork history' : 'Primary history',
            ...utterances,
          ])
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

  it('redraws the complete chat after splitting and resizing the terminal without losing the draft', async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    }) as unknown as NodeJS.ReadStream
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 180,
      rows: 50,
    }) as unknown as NodeJS.WriteStream
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
    const controller = new ChatController(backend(), { settings: { animations: false } })
    await controller.submit('hello!')
    let instance: Instance | undefined
    let incrementalRendering: boolean | undefined
    const running = runInkChat(controller, {
      intro: false,
      input,
      output,
      errorOutput: output,
      renderApp: (element, options) => {
        if (!options || !('incrementalRendering' in options)) {
          throw new Error('Expected Ink render options.')
        }
        incrementalRendering = options.incrementalRendering
        // Full frames let each write be compared against a fresh render.
        instance = render(element, { ...options, interactive: true, patchConsole: false, incrementalRendering: false })
        return instance
      },
    })

    try {
      expect(incrementalRendering).toBe(true)
      await vi.waitFor(() => expect(writes.join('')).toContain('Message Test'))
      input.push('draft')
      await vi.waitFor(() => expect(writes.join('')).toContain('draft'))
      writes.length = 0
      input.push('\n')
      await instance!.waitUntilRenderFlush()
      const multilineDraft = sanitizeTerminalText(
        renderToString(
          createElement(ChatView, {
            snapshot: controller.getSnapshot(),
            input: 'draft\n',
            cursor: 6,
            terminalWidth: output.columns,
            terminalHeight: output.rows,
            synchronousTranscriptLayout: true,
          }),
          { columns: output.columns }
        )
      ).trimEnd()
      await vi.waitFor(() => {
        const frame = writes.filter((write) => write.includes('draft')).at(-1) ?? ''
        expect(sanitizeTerminalText(frame).trimEnd()).toBe(multilineDraft)
      })
      writes.length = 0
      input.push('\u007f')
      await vi.waitFor(() => {
        expect(writes.some((write) => sanitizeTerminalText(write).includes('draft'))).toBe(true)
      })
      for (const [columns, rows] of [
        [90, 50],
        [60, 25],
        [180, 50],
      ] as const) {
        writes.length = 0
        output.columns = columns
        output.rows = rows
        output.emit('resize')
        await instance!.waitUntilRenderFlush()
        const expected = sanitizeTerminalText(
          renderToString(
            createElement(ChatView, {
              snapshot: controller.getSnapshot(),
              input: 'draft',
              cursor: 5,
              terminalWidth: columns,
              terminalHeight: rows,
              synchronousTranscriptLayout: true,
            }),
            { columns }
          )
        ).trimEnd()
        await vi.waitFor(() => {
          const frame = writes.filter((write) => write.includes('draft')).at(-1) ?? ''
          expect(sanitizeTerminalText(frame).trimEnd()).toBe(expected)
        })
      }
    } finally {
      controller.close(0)
      await running
    }
  })

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

  it('renders inside the alternate screen before initializing a controller', async () => {
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
    const renderApp = vi.fn((_element: unknown) => instance)
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

    expect(renderApp.mock.invocationCallOrder[0]).toBeLessThan(source.mock.invocationCallOrder[0]!)
    expect(instance.rerender).toHaveBeenCalledOnce()
    expect(writes.at(-1)).toContain('?1049l')
  })

  it('starts the first request as soon as the controller is ready while the intro is still running', async () => {
    const controller = new ChatController(backend())
    const start = vi.spyOn(controller, 'start')
    let resolveController!: (value: ChatController) => void
    const controllerTask = new Promise<ChatController>((resolve) => {
      resolveController = resolve
    })
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: async () => {},
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance
    let renderedRoot: unknown
    const renderApp = vi.fn((element: unknown) => {
      renderedRoot = element
      return instance
    })

    const runTask = runInkChat(() => controllerTask, {
      alternateScreen: false,
      firstRequest: 'hello',
      renderApp: renderApp as never,
    })

    await vi.waitFor(() => expect(renderApp).toHaveBeenCalledOnce())
    resolveController(controller)
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith('hello'))

    const root = renderedRoot as {
      props: { onIntroComplete(exitCode: 0 | 130): void }
    }
    root.props.onIntroComplete(0)
    await runTask
  })

  it('plays the intro before first-run setup and waits to construct the controller', async () => {
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
        onIntroComplete(exitCode: 0 | 130): void
        onSetupComplete(exitCode: 0 | 130): void
      }
    }
    expect(root.props.intro).toBe(true)
    expect(root.props.setup).toBe(true)
    root.props.onIntroComplete(0)
    await Promise.resolve()
    expect(source).not.toHaveBeenCalled()
    root.props.onSetupComplete(0)
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
