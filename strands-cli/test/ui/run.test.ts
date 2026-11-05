import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Instance } from 'ink'
import { Message, TextBlock } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { ChatController, type ChatControllerApi } from '../../src/ui/chat/controller.js'
import { type ChatConversation, type ChatConversations } from '../../src/agent/types.js'
import { applyProviderEnvironmentValues, CliConfigStore } from '../../src/config/store.js'
import { configurationFromStore, type RequestSetup, type SetupChange } from '../../src/agent/configuration.js'
import { runInkChat } from '../../src/ui/run.js'
import * as processTree from '../../src/terminal/process-tree.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import { workspaceSessionDirectory } from '../../src/session/catalog.js'
import { idleBackend } from '../fixtures/chat-backend.js'

describe('runInkChat', () => {
  it('tracks saved names through rename, conversation switches, and clear, then restores the terminal title', async () => {
    let currentSession = 'saved-session'
    const primary = new ChatController(
      {
        ...idleBackend(),
        info: () => ({ sessionId: currentSession }),
        clear: async () => {
          currentSession = 'fresh-session'
        },
      },
      {
        runtime: { session: 'Original name', sessionName: 'Original name' },
        sessions: {
          get current() {
            return currentSession
          },
          directory: '/tmp/sessions',
          list: async () => [],
          resolve: async () => {
            throw new Error('No session selected')
          },
          renameCurrent: async (name) => ({ sessionId: currentSession, name }),
        },
      }
    )
    const fork = new ChatController(idleBackend(), {
      runtime: { session: 'Other saved name', sessionName: 'Other saved name' },
    })
    const manager = new ConversationManager(primary, { fork: async () => fork })
    const writes: string[] = []
    const output = {
      isTTY: true,
      write: (value: string) => {
        writes.push(value)
        return true
      },
    } as unknown as NodeJS.WriteStream
    let finish!: () => void
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      rerender: vi.fn(),
      waitUntilExit: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    } as unknown as Instance
    const running = runInkChat(manager, {
      input: new PassThrough() as unknown as NodeJS.ReadStream,
      output,
      errorOutput: output,
      alternateScreen: false,
      intro: false,
      renderApp: (() => instance) as never,
    })

    try {
      await vi.waitFor(() => expect(finish).toBeDefined())
      await manager.submit('/rename Renamed session')
      await manager.submit('/help')
      await manager.submit('/fork')
      await manager.submit('/agents')
      await manager.activatePanelRow(manager.getSnapshot().panel!.rows.find((row) => !row.current)!)
      await manager.submit('/clear')
      expect(writes).toEqual([
        '\u001b[22;2t',
        '\u001b]2;Original name\u0007',
        '\u001b]2;Renamed session\u0007',
        '\u001b]2;Other saved name\u0007',
        '\u001b]2;Renamed session\u0007',
        '\u001b]2;Strands\u0007',
      ])
    } finally {
      finish()
      await running
    }
    expect(writes.at(-1)).toContain('?2004l')
    expect(writes.at(-1)).toContain('?2031l')
    expect(writes.at(-1)).toContain('?25h')
    expect(writes.filter((value) => value === '\u001b[23;2t')).toHaveLength(1)
  })

  it.each(['environment', 'profile'] as const)('restores chat and %s auth on failure', async (auth) => {
    vi.stubEnv('AWS_PROFILE', 'shell-profile')
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'shell-token')
    const config = CliConfigStore.memory(
      {},
      { toolOutput: 'full', animations: false, showReasoning: false, frogTheme: 'merlin' },
      {
        onboardingVersion: 0,
        profile: { name: 'Original' },
        providerEnvironment: auth === 'profile' ? { AWS_PROFILE: 'saved-profile' } : {},
      }
    )
    config.applyProviderEnvironment()
    const activeProfile = config.providerEnvironment().AWS_PROFILE
    const activeToken = process.env.AWS_BEARER_TOKEN_BEDROCK
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
      ...idleBackend(),
      captureConversation: async () => snapshot,
      sessionIdentity: session,
      sourceSelection: () => sourceSelection,
    }
    const previousController = new ChatController(previousBackend, { initialMessages: messages })
    const previous = new ConversationManager(previousController, { fork: async () => previousController })
    let current = previous
    const source = vi.fn(async (_signal: AbortSignal, _setup: () => void, conversations?: ChatConversations) => {
      if (!conversations) return previous
      const conversation = conversations.entries[0]!.conversation
      expect(previousBackend.dispose).not.toHaveBeenCalled()
      const controller = new ChatController(
        { ...idleBackend(), name: 'Customized Strands harness', captureConversation: async () => snapshot },
        { initialTurns: conversation.completedTurns }
      )
      current = new ConversationManager(controller, { fork: async () => controller })
      return current
    })
    let finish!: () => void
    let root!: {
      props: { onSetupComplete(code: 0, changed: boolean, change?: SetupChange): void; controller?: ChatControllerApi }
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
      source.mockImplementationOnce(async () => {
        config.applyProviderEnvironment()
        expect(process.env.AWS_PROFILE).toBe(auth === 'profile' ? 'shell-profile' : 'replacement-profile')
        expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe(auth === 'profile' ? 'shell-token' : undefined)
        throw new Error('Invalid configuration')
      })
      const before = configurationFromStore(config)
      root.props.onSetupComplete(0, true, {
        configuration: {
          ...before,
          profile: { ...before.profile, name: 'Invalid' },
          providerEnvironment: auth === 'profile' ? {} : { AWS_PROFILE: 'replacement-profile' },
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
      expect(config.providerEnvironment().AWS_PROFILE).toEqual(activeProfile)
      expect(process.env.AWS_PROFILE).toBe(activeProfile?.value)
      expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe(activeToken)
      expect(config.providerEnvironment().AWS_BEARER_TOKEN_BEDROCK?.value).toBe(activeToken)
      expect(config.needsSetup()).toBe(true)
      expect(root.props.controller).toBe(current)
      expect(current.getSnapshot().completedTurns[0]?.prompt).toBe('Remember the blue frog.')
      current.dismissPanel()
      await current.submit('Continue.')
      expect(current.getSnapshot().completedTurns).toHaveLength(2)
    } finally {
      finish()
      await running
      applyProviderEnvironmentValues({})
      vi.unstubAllEnvs()
    }
  })

  it.each([
    { kind: 'setup', fails: false },
    { kind: 'setup', fails: true },
    { kind: 'profile', fails: false },
    { kind: 'profile', fails: true },
  ])('preserves the applying conversation and CLI settings (kind=$kind, failure=$fails)', async ({ kind, fails }) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-setup-'))
    const configPath = join(directory, 'cli.toml')
    const config = await CliConfigStore.load(configPath)
    await config.saveSetup(configurationFromStore(config))
    let saved = await readFile(configPath, 'utf8')
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
    const primary = new ChatController({ ...idleBackend(), captureConversation: async () => snapshot })
    const fork = new ChatController({ ...idleBackend(), captureConversation: async () => snapshot })
    const previous = new ConversationManager(primary, { fork: async () => fork })
    let voicePaused = false
    const resumeVoiceInput = vi.fn(() => {
      voicePaused = false
    })
    vi.spyOn(previous, 'pauseVoiceInput').mockImplementation(() => {
      voicePaused = true
      return resumeVoiceInput
    })
    const captureConversations = previous.captureConversations.bind(previous)
    vi.spyOn(previous, 'captureConversations').mockImplementation(() => {
      expect(voicePaused).toBe(true)
      return captureConversations()
    })
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
    let replacement: ConversationManager | undefined
    const replacementError = 'Replacement \u001b[31mfailed\u001b[0m'
    const onFailure = vi.fn(async () => {})
    const source = async (
      _signal: AbortSignal,
      setup: RequestSetup,
      conversations?: ChatConversations
    ): Promise<ChatControllerApi> => {
      requestSetup = setup
      if (!conversations) return previous
      captured = conversations
      await gate
      if (fails) throw new Error(replacementError)
      const entries = conversations.entries.map(({ id, title, description, conversation }) => ({
        id,
        title,
        description,
        controller: new ChatController(idleBackend(), { initialTurns: conversation.completedTurns }),
      }))
      replacement = new ConversationManager(
        { activeId: conversations.activeId, entries },
        {
          fork: async () => {
            throw new Error('Unused')
          },
        }
      )
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
      requestSetup({
        conversationId: 'agent-1',
        ...(kind === 'profile' ? { profile: configuration.profile } : { configuration, agentProject }),
        onFailure,
      })
      await vi.waitFor(() => expect(captured).toBeDefined())
      await vi.waitFor(() => expect(rendered).toContain('Reloading agent...'))
      expect(voicePaused).toBe(true)
      expect(config.snapshot().profile.name).toBe(kind === 'profile' ? 'Strands harness' : 'Replacement')
      expect(config.snapshot().agentProject).toBe(kind === 'profile' ? undefined : agentProject)
      expect(await readFile(configPath, 'utf8')).toBe(saved)
      if (kind === 'profile') {
        await config.saveSetup({
          ...configurationFromStore(config),
          providers: ['ollama'],
          providerEnvironment: { AWS_REGION: 'us-west-2' },
          permissionMode: 'bypassPermissions',
          allowedTools: ['write'],
          settings: { frogTheme: 'oak', skillDiscovery: true },
        })
        saved = await readFile(configPath, 'utf8')
      }
      expect(captured!.activeId).toBe('agent-2')
      expect(
        captured!.entries.map(({ id, conversation }) => [id, conversation.completedTurns.map((turn) => turn.prompt)])
      ).toEqual([
        ['agent-1', ['Primary history']],
        ['agent-2', ['Fork history']],
      ])
      expect(primary.getSnapshot().completedTurns).toHaveLength(1)
      expect(fork.getSnapshot().completedTurns).toHaveLength(1)
      rendered = ''
      release()
      if (!fails) {
        await vi.waitFor(() => expect(previous.dispose).toHaveBeenCalledOnce())
        expect(voicePaused).toBe(true)
        await instance.waitUntilRenderFlush()
        expect(rendered).not.toContain('Primary history')
        finishDisposal()
      }
      await vi.waitFor(() => {
        const active = fails ? previous : replacement
        expect(active?.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual(['Fork history'])
        expect(active?.getSnapshot().completedTurns.every((turn) => turn.status === 'complete')).toBe(true)
      })
      await vi.waitFor(() => expect(resumeVoiceInput).toHaveBeenCalledOnce())
      expect(voicePaused).toBe(false)
      const reloaded = (await CliConfigStore.load(configPath)).snapshot()
      expect(reloaded).toEqual(config.snapshot())
      expect(reloaded.profile.name).toBe(fails ? 'Strands harness' : 'Replacement')
      expect(reloaded.agentProject).toBe(fails || kind === 'profile' ? undefined : agentProject)
      if (kind === 'profile') {
        expect(reloaded).toMatchObject({
          providers: { enabled: ['ollama'] },
          permissions: { mode: 'bypassPermissions', allow: ['write'] },
          settings: { frogTheme: 'oak', skillDiscovery: true },
        })
        expect(config.configuredProviderEnvironment()).toEqual({ AWS_REGION: 'us-west-2' })
      }
      if (fails) {
        expect(await readFile(configPath, 'utf8')).toBe(saved)
        expect(onFailure).toHaveBeenCalledExactlyOnceWith(replacementError)
        expect(rendered).toContain('error: Failed to apply setup: Replacement failed')
        expect(rendered).not.toContain(replacementError)
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
  })

  it('restores the AWS profile when exiting while a replacement is starting', async () => {
    vi.stubEnv('AWS_PROFILE', 'shell-profile')
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'shell-token')
    const config = CliConfigStore.memory()
    const configuration = configurationFromStore(config)
    const snapshot: ChatConversation['snapshot'] = {
      scope: 'agent',
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      data: {},
      appData: {},
    }
    const previous = new ChatController({ ...idleBackend(), captureConversation: async () => snapshot })
    const replacement = new ChatController(idleBackend())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = vi.fn(async (): Promise<ChatControllerApi> => {
      if (source.mock.calls.length === 1) return previous
      config.applyProviderEnvironment()
      expect(process.env.AWS_PROFILE).toBe('replacement-profile')
      expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
      await gate
      return replacement
    })
    let finish!: () => void
    let root!: {
      props: { onSetupComplete(code: 0, changed: boolean, change?: SetupChange): void; controller?: ChatControllerApi }
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
      config,
      alternateScreen: false,
      errorOutput: new PassThrough() as unknown as NodeJS.WriteStream,
      renderApp: ((element: unknown) => {
        root = element as typeof root
        return instance
      }) as never,
    })
    try {
      await vi.waitFor(() => expect(finish).toBeDefined())
      root.props.onSetupComplete(0, true, {
        configuration: { ...configuration, providerEnvironment: { AWS_PROFILE: 'replacement-profile' } },
      })
      await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(2))
      root.props.controller!.close(130)
      release()
      await expect(running).resolves.toBe(130)
      expect(configurationFromStore(config)).toEqual(configuration)
      expect(config.providerEnvironment().AWS_PROFILE).toEqual({ value: 'shell-profile', source: 'process' })
      expect(process.env.AWS_PROFILE).toBe('shell-profile')
      expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('shell-token')
    } finally {
      release()
      instance.unmount()
      await running
      applyProviderEnvironmentValues({})
      vi.unstubAllEnvs()
    }
  })

  it.each([
    { exitCode: 0, saved: true },
    { exitCode: 130, saved: true },
    { exitCode: 0, saved: false },
  ])('restores the terminal before resume advice on exit ($exitCode, saved=$saved)', async ({ exitCode, saved }) => {
    const target = idleBackend()
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
    const exitListeners = process.listenerCount('exit')
    const exceptionListeners = process.listenerCount('uncaughtExceptionMonitor')

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
    expect(process.listenerCount('exit')).toBe(exitListeners)
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(exceptionListeners)
  })

  it('waits for resume advice to flush before forcing an interrupted session to exit', async () => {
    const controller = new ChatController(idleBackend())
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

  it('restores the terminal when Ink fails to mount', async () => {
    const controller = new ChatController(idleBackend())
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

  it('finishes terminal restoration when renderer cleanup throws', async () => {
    const controller = new ChatController(idleBackend())
    controller.close(23)
    const writes: string[] = []
    const output = { isTTY: true, write: (value: string) => writes.push(value) } as unknown as NodeJS.WriteStream
    const cleanup = vi.fn()
    const result = await runInkChat(controller, {
      output,
      input: ttyInput(),
      intro: false,
      renderApp: (() => ({
        unmount: () => {
          throw new Error('Renderer cleanup failed')
        },
        cleanup,
        waitUntilExit: async () => {},
      })) as never,
    })
    expect(result).toBe(23)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(writes.join('')).toContain('?1049l')
    expect(writes.join('')).toContain('\u001b[23;2t')
    expect(writes.at(-1)).toContain('?2004l')
    expect(writes.at(-1)).toContain('?2031l')
    expect(writes.at(-1)).toContain('?25h')
  })

  it('cancels startup MCP trust with Ctrl-C and restores the terminal before forced exit', async () => {
    const forcedExit = new Error('forced startup exit')
    const input = ttyInput()
    vi.mocked(input.setRawMode).mockImplementation((mode) => {
      input.isRaw = mode
      return input
    })
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 })
    let written = ''
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString()
    })
    const sigintListeners = process.listenerCount('SIGINT')
    const hardExit = vi.spyOn(processTree, 'hardExitProcessTree').mockImplementation(() => {
      expect(input.setRawMode).toHaveBeenLastCalledWith(false)
      expect(written).toContain('?1049l')
      expect(written).toContain('?2031l')
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

  it('shows startup progress until the controller can accept the first typed request', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const frame = captureFrame(output)
    const controller = new ChatController(idleBackend())
    let ready!: (value: ChatController) => void
    const pending = new Promise<ChatController>((resolve) => {
      ready = resolve
    })
    const source = vi.fn(() => pending)
    const running = runInkChat(source, {
      input,
      output,
      errorOutput: output,
      config: CliConfigStore.memory(),
      renderApp: (element, options) => render(element, { ...options, incrementalRendering: false }),
    })
    try {
      await vi.waitFor(() => expect(source).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Starting agent…'))
      expect(frame().join('\n')).not.toContain('Enter to send')
      ready(controller)
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Enter to send'))
      input.write('First ready request')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('First ready request'))
      input.write('\r')
      await vi.waitFor(() => expect(controller.getSnapshot().completedTurns[0]?.prompt).toBe('First ready request'))
    } finally {
      ready(controller)
      controller.close(0)
      await running
      input.destroy()
    }
  })

  it('renders and starts the first request when the controller is ready without waiting for the intro', async () => {
    const controller = new ChatController(idleBackend())
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

  it('opens chat on Escape from fresh setup, supports returning to setup, and exits on Ctrl+C', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const frame = captureFrame(output)
    const config = CliConfigStore.memory({}, { animations: false }, { onboardingVersion: 0 })
    const backend = idleBackend()
    let controller: ChatController | undefined
    const source = vi.fn(async (_signal: AbortSignal, requestSetup: RequestSetup) => {
      controller = new ChatController(backend, { requestSetup, settings: config.snapshot().settings })
      return controller
    })
    const running = runInkChat(source, {
      input,
      output,
      errorOutput: output,
      alternateScreen: false,
      intro: false,
      setup: true,
      config,
      checkForUpdate: async () => undefined,
      renderApp: (element, options) => render(element, { ...options, incrementalRendering: false }),
    })

    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Esc to open chat'))
      expect(source).not.toHaveBeenCalled()
      input.write('\u001b')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Enter to send'))
      expect(source).toHaveBeenCalledOnce()

      input.write('/setup')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('/setup'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Esc to return to chat'))
      input.write('\u001b')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Enter to send'))
      expect(source).toHaveBeenCalledOnce()
      expect(config.needsSetup()).toBe(true)

      input.write('\u0003')
      await expect(running).resolves.toBe(130)
      expect(backend.dispose).toHaveBeenCalledOnce()
    } finally {
      controller?.close(0)
      input.write('\u0003')
      await running
      input.destroy()
    }
  })

  it('cancels initial setup without waiting for its completion', async () => {
    const source = vi.fn(async () => new ChatController(idleBackend()))
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

  it('leaves terminal mode before handing an accepted update back to the CLI', async () => {
    const controller = new ChatController(idleBackend())
    const onUpdateRequested = vi.fn()
    let finish!: () => void
    let root!: { props: { onUpdateRequested(): void } }
    const instance = {
      unmount: vi.fn(() => finish()),
      cleanup: vi.fn(),
      waitUntilExit: () => new Promise<void>((resolve) => (finish = resolve)),
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance

    const running = runInkChat(controller, {
      alternateScreen: false,
      onUpdateRequested,
      renderApp: ((element: unknown) => {
        root = element as typeof root
        return instance
      }) as never,
    })

    await vi.waitFor(() => expect(root).toBeDefined())
    root.props.onUpdateRequested()

    await expect(running).resolves.toBe(0)
    expect(onUpdateRequested).toHaveBeenCalledOnce()
    expect(instance.cleanup).toHaveBeenCalledOnce()
  })

  it('does not construct an agent when an update is accepted during setup', async () => {
    const controller = new ChatController(idleBackend())
    const source = vi.fn(async () => controller)
    let root!: { props: { onUpdateRequested(): void } }
    const instance = {
      unmount: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: async () => {},
      rerender: vi.fn(),
      clear: vi.fn(),
    } as unknown as Instance

    const running = runInkChat(source, {
      alternateScreen: false,
      setup: true,
      config: CliConfigStore.memory(),
      onUpdateRequested: () => {},
      renderApp: ((element: unknown) => {
        root = element as typeof root
        return instance
      }) as never,
    })

    await vi.waitFor(() => expect(root).toBeDefined())
    root.props.onUpdateRequested()

    await expect(running).resolves.toBe(130)
    expect(source).not.toHaveBeenCalled()
  })
})

describe('conversation portability', () => {
  it('refuses to fork a source that cannot reconstruct its agent', async () => {
    const primary = new ChatController({ ...idleBackend(), reconstructable: () => false })
    const fork = vi.fn(async () => new ChatController(idleBackend()))
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
