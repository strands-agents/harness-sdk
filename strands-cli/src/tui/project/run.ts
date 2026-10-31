import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { TurnRenderer } from '../../console.js'

import { importAgentProject } from './import.js'
import { exportSourceProject } from './export.js'
import {
  ChatController,
  type ChatConfigurationSource,
  type ChatConversation,
  type ChatConversations,
  type ChatSettings,
} from '../chat/controller.js'
import { isUnresolvedBackgroundTask } from '../chat/controller-helpers.js'
import { configurationSource } from '../configuration-source.js'
import type { RequestSetup } from '../agent-configuration.js'
import type { CliConfigStore } from '../config.js'
import { HARNESS_VERSION } from '../package-version.js'
import { AgentMessaging } from '../messaging.js'
import { ConversationManager, type InitialConversations } from '../session/conversations.js'
import { FileSessionRuntime, SessionRootCatalog } from '../session/sessions.js'
import { DEFAULT_STREAM_PRESENTATION } from '../stream-presentation.js'
import { errorMessage } from '../terminal/sanitize.js'
import { PythonVoiceSession } from '../voice/session.js'
import { PythonBackend, type PythonOptions } from './python.js'
import { TypescriptBackend, type TypescriptInit } from './typescript-backend.js'

export async function createTypescriptChat(
  path: string,
  config: CliConfigStore,
  options: Omit<TypescriptInit, 'project' | 'config' | 'peerEndpointId'>,
  signal: AbortSignal,
  requestSetup: RequestSetup,
  conversations?: ChatConversations,
  conversationId = conversations?.activeId
): Promise<ConversationManager> {
  const project = importAgentProject(path)
  const messaging = new AgentMessaging()
  const catalog = await SessionRootCatalog.load().catch(() => undefined)
  let nextEndpoint = 1
  for (const entry of conversations?.entries ?? []) {
    nextEndpoint = Math.max(nextEndpoint, Number(entry.id.slice('agent-'.length)) + 1)
  }
  let disposed = false
  const openController = async (
    initialOptions: typeof options,
    peerEndpointId = `agent-${nextEndpoint++}`,
    settings?: Partial<ChatSettings>
  ): Promise<ChatController> => {
    if (disposed) throw new Error('Runtime is disposed.')
    const { backend, messages } = await TypescriptBackend.open(
      { ...initialOptions, project, peerEndpointId },
      config,
      messaging,
      signal
    )
    try {
      signal.throwIfAborted()
      if (disposed) throw new Error('Runtime was disposed while building an agent.')
      const sessions = new FileSessionRuntime(backend, backend.sessionDirectory, {
        ...(catalog ? { catalog } : {}),
        workspace: backend.cwd,
        currentSessionResumable: backend.sessionIdentity !== undefined,
      })
      const sessionName = sessions.current ? (await sessions.resolve(sessions.current)).name : undefined
      if (disposed) throw new Error('Runtime was disposed while building an agent.')
      const conversation = initialOptions.conversation
      const controller = new ChatController(backend, {
        runtime: {
          version: HARNESS_VERSION,
          cwd: backend.cwd,
          session: sessionName ?? backend.sessionId ?? (backend.state.managedSession ? 'managed' : 'in-memory'),
          ...(sessionName ? { sessionName } : {}),
        },
        settings: { ...config.snapshot().settings, ...settings },
        initialMessages: messages,
        ...(conversation ? { initialTurns: conversation.completedTurns } : {}),
        ...(conversation?.configurationBaseline
          ? { initialConfigurationBaseline: conversation.configurationBaseline }
          : {}),
        sessions,
        skills: backend.skills,
        mcp: backend.mcp,
        streamPresentation: DEFAULT_STREAM_PRESENTATION,
        setSettings: async (next): Promise<void> => {
          await config.setSettings(next)
          await backend.syncConfiguration()
        },
        requestSetup,
        project,
        exportAgentProject: (language, destination, output): Promise<string | undefined> =>
          exportSourceProject(
            project,
            backend.name,
            language,
            [backend.sessionDirectory, ...backend.privatePaths],
            destination,
            output
          ),
        configurationSource: (): ChatConfigurationSource =>
          configurationSource(
            backend.state.profile,
            project,
            config.snapshot().profileBaseDir ?? options.initialWorkspace
          ),
        useExportedProject: (agentProject): void => requestSetup({ agentProject, conversationId: peerEndpointId }),
        peerEndpointId,
      })
      const stopController = controller.subscribe(() => {
        if (controller.busy) return
        const snapshot = controller.getSnapshot()
        const complete = snapshot.completedTurns.at(-1)?.status === 'complete'
        if (complete && snapshot.tasks.some(isUnresolvedBackgroundTask)) return
        const change = backend.takeConfigurationChange()
        if (!change) return
        if (complete) {
          requestSetup({ ...change, conversationId: peerEndpointId })
        } else {
          const message =
            'The turn did not complete, so the configuration was not applied. The previous agent remains active. ' +
            'Ask the agent to apply the draft again when ready.'
          controller.showError('Setup not applied', message)
          void change.onFailure?.(message).catch((error: unknown) => {
            controller.showError('Setup not applied', `${message}\nCould not save this notice: ${errorMessage(error)}`)
          })
        }
      })
      const stopConfiguration = backend.subscribeConfiguration(() => controller.refreshConfiguration())
      backend.onDispose(() => {
        stopController()
        stopConfiguration()
        messaging.unregister(peerEndpointId)
      })
      messaging.register({
        id: peerEndpointId,
        name: peerEndpointId,
        status: () => (controller.busy ? 'working' : 'idle'),
        enqueue: (message) => controller.enqueuePeerMessage(message),
      })
      return controller
    } catch (error) {
      await backend.dispose()
      throw error
    }
  }
  const entries: InitialConversations['entries'][number][] = []
  try {
    if (conversations) {
      for (const entry of conversations.entries) {
        const controller = await openController(
          {
            ...options,
            cwd: entry.conversation.workspace,
            conversation: entry.conversation,
            preserveSession: entry.id !== conversationId,
          },
          entry.id
        )
        entries.push({ id: entry.id, title: entry.title, description: entry.description, controller })
      }
    } else {
      const controller = await openController(options)
      entries.push({
        id: 'agent-1',
        title: controller.backend.name,
        description: controller.backend.info?.().description || 'Primary agent',
        controller,
      })
    }
    return new ConversationManager(
      { activeId: conversations?.activeId ?? 'agent-1', entries },
      {
        fork: async (source): Promise<ChatController> => {
          if (!(source.backend instanceof TypescriptBackend)) throw new Error('Expected a TypeScript conversation.')
          const seed = await source.backend.captureFork()
          return openController(
            {
              ...options,
              cwd: source.backend.cwd,
              sessionDirectory: source.backend.sessionDirectory,
              freshSession: true,
              seed,
            },
            undefined,
            source.getSnapshot().settings
          )
        },
        resume: async (source, target): Promise<ChatController> => {
          if (!(source.backend instanceof TypescriptBackend)) throw new Error('Expected a TypeScript conversation.')
          await source.backend.flush()
          return openController(
            {
              ...options,
              cwd: target.workspace,
              sessionId: target.sessionId,
              sessionDirectory: target.sessionDirectory,
              selection: source.backend.modelSelection(),
              restoreSeedMessages: false,
            },
            undefined,
            source.getSnapshot().settings
          )
        },
        dispose: (): void => {
          disposed = true
        },
        agentMessaging: messaging,
        voice: new PythonVoiceSession({ cwd: options.initialWorkspace }),
        project,
        projectPrivatePaths: entries.flatMap(({ controller }) => {
          const backend = controller.backend as TypescriptBackend
          return [backend.sessionDirectory, ...backend.privatePaths].map((path) => resolve(backend.cwd, path))
        }),
        reloadProject: (conversationId): void => requestSetup({ agentProject: project.entrypoint, conversationId }),
      }
    )
  } catch (error) {
    disposed = true
    await Promise.allSettled(entries.map(({ controller }) => controller.dispose()))
    throw error
  }
}

export async function createPythonChat(
  path: string,
  config: CliConfigStore,
  options: PythonOptions,
  signal: AbortSignal,
  requestSetup: RequestSetup,
  conversations?: ChatConversations,
  conversationId = conversations?.activeId
): Promise<ConversationManager> {
  const project = importAgentProject(path)
  const createController = async (backend: PythonBackend, conversation?: ChatConversation): Promise<ChatController> => {
    const snapshot = config.snapshot()
    const sessions = new FileSessionRuntime(backend, backend.sessionDirectory, {
      workspace: backend.cwd,
      currentSessionResumable: backend.sessionIdentity !== undefined,
    })
    const sessionName = sessions.current ? (await sessions.resolve(sessions.current)).name : undefined
    return new ChatController(backend, {
      runtime: {
        cwd: backend.cwd,
        version: HARNESS_VERSION,
        session: sessionName ?? backend.sessionId ?? 'managed',
        ...(sessionName ? { sessionName } : {}),
      },
      settings: snapshot.settings,
      initialMessages: backend.messages,
      ...(conversation ? { initialTurns: conversation.completedTurns } : {}),
      ...(conversation?.configurationBaseline
        ? { initialConfigurationBaseline: conversation.configurationBaseline }
        : {}),
      sessions,
      skills: { list: () => Promise.resolve(backend.skills), activate: (name) => backend.activateSkill(name) },
      skillNames: backend.skills.map((skill) => skill.name),
      setSettings: (settings) => config.setSettings(settings),
      requestSetup,
      project,
      exportAgentProject: (language, destination, output): Promise<string | undefined> => {
        return exportSourceProject(project, backend.name, language, backend.privatePaths, destination, output)
      },
      configurationSource: () => configurationSource(config.snapshot().profile, project),
    })
  }
  const openController = async (
    initialOptions: PythonOptions,
    conversation?: ChatConversation
  ): Promise<ChatController> => {
    const backend = await PythonBackend.open(project, config, initialOptions, signal)
    try {
      if (conversation) await backend.restoreConversation(conversation)
      return await createController(backend, conversation)
    } catch (error) {
      await backend.dispose()
      throw error
    }
  }
  const entries: InitialConversations['entries'][number][] = []
  try {
    if (conversations) {
      for (const entry of conversations.entries) {
        const conversation = entry.conversation
        const controller = await openController(
          {
            ...options,
            interactive: true,
            cwd: conversation.workspace,
            ...(conversation.sourceSelection ? { sourceSelection: conversation.sourceSelection } : {}),
            ...(conversation.session
              ? { restoreSession: { identity: conversation.session, preserve: entry.id !== conversationId } }
              : {}),
          },
          conversation
        )
        entries.push({ id: entry.id, title: entry.title, description: entry.description, controller })
      }
    } else {
      const controller = await openController({ ...options, interactive: true })
      entries.push({
        id: 'agent-1',
        title: controller.backend.name,
        description: controller.backend.info?.().description || 'Primary agent',
        controller,
      })
    }
    const privatePaths: string[] = []
    for (const { controller } of entries) {
      privatePaths.push(...(controller.backend as PythonBackend).privatePaths)
    }
    return new ConversationManager(
      { activeId: conversations?.activeId ?? 'agent-1', entries },
      {
        fork: async (source): Promise<ChatController> => {
          if (!(source.backend instanceof PythonBackend)) throw new Error('Expected a Python conversation.')
          return createController(await source.backend.fork({ ...options, interactive: true }, signal))
        },
        resume: async (_source, target): Promise<ChatController> =>
          openController({
            ...options,
            interactive: true,
            sessionId: target.sessionId,
            sessionDir: target.sessionDirectory,
            cwd: target.workspace,
            resume: true,
          }),
        voice: new PythonVoiceSession({ cwd: options.cwd ?? process.cwd() }),
        project,
        projectPrivatePaths: privatePaths,
        reloadProject: (conversationId): void => requestSetup({ agentProject: project.entrypoint, conversationId }),
      }
    )
  } catch (error) {
    await Promise.allSettled(entries.map(({ controller }) => controller.dispose()))
    throw error
  }
}

export async function runPythonConsole(
  path: string,
  config: CliConfigStore,
  options: PythonOptions,
  request: string | undefined,
  interactive: boolean
): Promise<void> {
  const backend = await PythonBackend.open(importAgentProject(path), config, options)
  const terminal = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  const cancel = (): void => backend.cancel()
  process.on('SIGINT', cancel)
  try {
    let prompt = request
    while (true) {
      if (prompt) {
        const renderer = new TurnRenderer()
        let streamed = false
        const stream = backend.stream(prompt)
        let next = await stream.next()
        while (!next.done) {
          const event = next.value
          if (event.type === 'textDelta') {
            streamed = true
          }
          if (event.type === 'permission') {
            if (!terminal) {
              backend.respondPermission(event.request.id, 'deny')
              throw new Error('The agent needs approval. Open it in the strands TUI to respond.')
            }
            const answer = await terminal.question(`Allow ${event.request.toolName}? [y/N] `)
            backend.respondPermission(event.request.id, answer.toLowerCase() === 'y' ? 'allow' : 'deny')
          } else {
            renderer.handleChat(event)
          }
          next = await stream.next()
        }
        if (!streamed && next.value.finalText) renderer.handleChat({ type: 'textDelta', text: next.value.finalText })
        const usage = next.value.usage
        renderer.finish(
          usage && usage.inputTokens !== undefined && usage.outputTokens !== undefined
            ? {
                metrics: {
                  accumulatedUsage: { ...usage, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
                },
              }
            : undefined
        )
      }
      if (!terminal) break
      prompt = await terminal.question('> ')
      if (['/exit', '/quit', 'exit', 'quit'].includes(prompt.trim())) break
    }
  } finally {
    process.off('SIGINT', cancel)
    terminal?.close()
    await backend.dispose()
  }
}
