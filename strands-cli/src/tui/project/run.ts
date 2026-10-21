import { createInterface } from 'node:readline/promises'
import { TurnRenderer } from '../../console.js'

import { importAgentProject } from './import.js'
import { exportSourceProject } from './export.js'
import { ChatController, type ChatConversation } from '../chat/controller.js'
import { configurationSource } from '../configuration-source.js'
import type { RequestSetup } from '../agent-configuration.js'
import type { CliConfigStore } from '../config.js'
import { HARNESS_VERSION } from '../package-version.js'
import { ConversationManager } from '../session/conversations.js'
import { FileSessionRuntime } from '../session/sessions.js'
import { PythonVoiceSession } from '../voice/session.js'
import { PythonBackend, type PythonOptions } from './python.js'

export async function createPythonChat(
  path: string,
  config: CliConfigStore,
  options: PythonOptions,
  signal: AbortSignal,
  requestSetup: RequestSetup,
  conversation?: ChatConversation
): Promise<ConversationManager> {
  const project = importAgentProject(path)
  const createController = async (
    backend: PythonBackend,
    initialTurns?: ChatConversation['completedTurns']
  ): Promise<ChatController> => {
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
      ...(initialTurns ? { initialTurns } : {}),
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
  const backend = await PythonBackend.open(
    project,
    config,
    {
      ...options,
      interactive: true,
      ...(conversation?.session ? { cwd: conversation.session.workspace } : {}),
      ...(conversation?.sourceSelection ? { sourceSelection: conversation.sourceSelection } : {}),
    },
    signal
  )
  try {
    if (conversation) {
      await backend.restoreConversation(conversation)
    }
    return new ConversationManager(await createController(backend, conversation?.completedTurns), {
      fork: async (source): Promise<ChatController> => {
        if (!(source.backend instanceof PythonBackend)) throw new Error('Expected a Python conversation.')
        return createController(await source.backend.fork({ ...options, interactive: true }, signal))
      },
      resume: async (_source, target): Promise<ChatController> =>
        createController(
          await PythonBackend.open(
            project,
            config,
            {
              ...options,
              interactive: true,
              sessionId: target.sessionId,
              sessionDir: target.sessionDirectory,
              cwd: target.workspace,
              resume: true,
            },
            signal
          )
        ),
      voice: new PythonVoiceSession({ cwd: options.cwd ?? process.cwd() }),
      project,
      projectPrivatePaths: backend.privatePaths,
      reloadProject: (conversationId): void => requestSetup({ agentProject: project.entrypoint, conversationId }),
    })
  } catch (error) {
    await backend.dispose()
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
