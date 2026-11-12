import { resolve } from 'node:path'
import { containsPath } from '../../paths.js'
import { type HarnessAgentConfig } from '@strands-agents/harness'

import {
  configurationFromStore,
  createBuiltinToolsRuntime,
  type RequestSetup,
  type WorkspaceAction,
} from '../../agent/configuration.js'
import { configurationSource } from '../../config/source.js'
import { agentPrivatePaths, exportAgentProject, exportSourceProject } from '../../project/export.js'
import { type ChatConfigurationSource, type ChatConversation, type ChatConversations } from '../../agent/types.js'
import { type ChatSettings } from '../../config/settings.js'
import { ChatController, type ChatControllerOptions } from './controller.js'
import { isUnresolvedBackgroundTask } from './state.js'
import { ConversationManager, type InitialConversations } from './conversations.js'
import { CliConfigStore } from '../../config/store.js'
import { AgentMessaging } from '../../agent/messaging.js'
import { AgentModelRuntime } from '../../model/runtime.js'
import { discoverAwsConfiguration } from '../../model/aws-config.js'
import {
  sessionSettings,
  DEFAULT_SESSION_DIR,
  FileSessionRuntime,
  SessionRootCatalog,
  type SessionTarget,
} from '../../session/sessions.js'
import { HARNESS_VERSION } from '../../package-version.js'
import { resolveSkillPaths } from '../../agent/skills.js'
import { DEFAULT_STREAM_PRESENTATION } from './stream-presentation.js'
import { errorMessage } from '../../terminal/text.js'
import { PythonVoiceSession } from '../../agent/voice.js'
import { importAgentProject, type ImportedAgentProject } from '../../project/import.js'
import { PythonBackend, type PythonOptions } from '../../project/python.js'
import { TypescriptBackend, type TypescriptInit } from '../../project/typescript-backend.js'
import { temporaryDevCommands } from '../../dev/temporary-evals-fork/command.js'
import { readDevWorkspace, type DevWorkspace } from '../../dev/workspace.js'
import {
  createInteractiveRuntime,
  type CreateInteractiveRuntimeOptions,
  type RuntimeBackendRequest,
} from '../../agent/runtime.js'

async function restoreSessionNames(
  sessions: FileSessionRuntime,
  conversation?: ChatConversation
): Promise<Pick<SessionTarget, 'name' | 'agentName'>> {
  const names: Pick<SessionTarget, 'name' | 'agentName'> = sessions.current
    ? await sessions.resolve(sessions.current)
    : {}
  if (!conversation?.agentName) return names
  const previous = conversation.session
  const current = sessions.currentTarget
  if (
    current &&
    conversation.agentName !== names.agentName &&
    (!previous ||
      previous.sessionId !== current.sessionId ||
      resolve(previous.sessionDirectory) !== current.sessionDirectory)
  ) {
    await sessions.renameAgent(conversation.agentName)
  }
  return { ...names, agentName: conversation.agentName }
}

const nestedWorkspace = (project: ImportedAgentProject, workspace: DevWorkspace | undefined): string[] =>
  workspace?.directory && workspace.directory !== project.root && containsPath(project.root, workspace.directory)
    ? [workspace.directory]
    : []

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
  const devWorkspace = options.args.dev?.workspace ? await readDevWorkspace(options.args.dev.workspace) : undefined
  const messaging = new AgentMessaging()
  const catalog = await SessionRootCatalog.load(
    options.args.dev?.workspace ? resolve(options.args.dev.workspace, '.strands/state/catalog') : undefined
  ).catch(() => undefined)
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
      const conversation = initialOptions.conversation
      const { name: sessionName, agentName } = await restoreSessionNames(sessions, conversation)
      if (disposed) throw new Error('Runtime was disposed while building an agent.')
      const controller = new ChatController(backend, {
        runtime: {
          version: HARNESS_VERSION,
          ...(devWorkspace
            ? {
                devWorkspace: {
                  root: devWorkspace.directory ?? devWorkspace.root,
                  entrypoint: project.entrypoint,
                  boundEntrypoint: devWorkspace.entrypoint,
                  origin: devWorkspace.config.origin.kind,
                },
              }
            : {}),
          cwd: backend.cwd,
          session: sessionName ?? backend.sessionId ?? (backend.state.managedSession ? 'managed' : 'in-memory'),
          ...(sessionName ? { sessionName } : {}),
          ...(agentName ? { agent: agentName } : {}),
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
        ...(devWorkspace
          ? {
              workspaceAction: (action: WorkspaceAction): void => requestSetup({ workspaceAction: action }),
              devCommands: temporaryDevCommands(devWorkspace, project),
            }
          : {}),
        awsProfile: awsProfileSelection(config, requestSetup, peerEndpointId, project.entrypoint),
        project,
        exportAgentProject: (language, destination, output): Promise<string | undefined> =>
          exportSourceProject(
            project,
            backend.name,
            language,
            backend.privatePaths === null
              ? null
              : [backend.sessionDirectory, ...backend.privatePaths, ...nestedWorkspace(project, devWorkspace)],
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
        entries.push({
          id: entry.id,
          title: controller.name,
          description: entry.description,
          controller,
        })
      }
    } else {
      const controller = await openController(options)
      entries.push({
        id: 'agent-1',
        title: controller.name,
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
        projectPrivatePaths: entries.some(
          ({ controller }) => (controller.backend as TypescriptBackend).privatePaths === null
        )
          ? null
          : entries.flatMap(({ controller }) => {
              const backend = controller.backend as TypescriptBackend
              return [
                backend.sessionDirectory,
                ...(backend.privatePaths ?? []),
                ...nestedWorkspace(project, devWorkspace),
              ].map((path) => resolve(backend.cwd, path))
            }),
        reloadProject: (conversationId, paths): void =>
          requestSetup({ agentProject: project.entrypoint, conversationId, reloadedFiles: paths }),
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
  const devWorkspace = options.devWorkspace ? await readDevWorkspace(options.devWorkspace) : undefined
  const createController = async (backend: PythonBackend, conversation?: ChatConversation): Promise<ChatController> => {
    const snapshot = config.snapshot()
    const sessions = new FileSessionRuntime(backend, backend.sessionDirectory, {
      workspace: backend.cwd,
      currentSessionResumable: backend.sessionIdentity !== undefined,
    })
    const { name: sessionName, agentName } = await restoreSessionNames(sessions, conversation)
    return new ChatController(backend, {
      runtime: {
        cwd: backend.cwd,
        version: HARNESS_VERSION,
        ...(devWorkspace
          ? {
              devWorkspace: {
                root: devWorkspace.directory ?? devWorkspace.root,
                entrypoint: project.entrypoint,
                boundEntrypoint: devWorkspace.entrypoint,
                origin: devWorkspace.config.origin.kind,
              },
            }
          : {}),
        session: sessionName ?? backend.sessionId ?? 'managed',
        ...(sessionName ? { sessionName } : {}),
        ...(agentName ? { agent: agentName } : {}),
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
      ...(devWorkspace
        ? {
            workspaceAction: (action: WorkspaceAction): void => requestSetup({ workspaceAction: action }),
            devCommands: temporaryDevCommands(devWorkspace, project),
          }
        : {}),
      awsProfile: awsProfileSelection(config, requestSetup, undefined, project.entrypoint),
      project,
      exportAgentProject: (language, destination, output): Promise<string | undefined> => {
        const privatePaths = backend.privatePaths
        return exportSourceProject(
          project,
          backend.name,
          language,
          privatePaths === null ? null : [...privatePaths, ...nestedWorkspace(project, devWorkspace)],
          destination,
          output
        )
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
        entries.push({
          id: entry.id,
          title: controller.name,
          description: entry.description,
          controller,
        })
      }
    } else {
      const controller = await openController({ ...options, interactive: true })
      entries.push({
        id: 'agent-1',
        title: controller.name,
        description: controller.backend.info?.().description || 'Primary agent',
        controller,
      })
    }
    let privatePaths: string[] | null = []
    for (const { controller } of entries) {
      const paths = (controller.backend as PythonBackend).privatePaths
      if (paths === null) {
        privatePaths = null
        break
      }
      privatePaths.push(...paths)
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
        projectPrivatePaths:
          privatePaths === null ? null : [...privatePaths, ...nestedWorkspace(project, devWorkspace)],
        reloadProject: (conversationId, paths): void =>
          requestSetup({ agentProject: project.entrypoint, conversationId, reloadedFiles: paths }),
      }
    )
  } catch (error) {
    await Promise.allSettled(entries.map(({ controller }) => controller.dispose()))
    throw error
  }
}

interface CreateInteractiveChatOptions extends Omit<
  CreateInteractiveRuntimeOptions,
  'config' | 'agentMessaging' | 'peerMessageRouter' | 'configurationEnabled' | 'allowRebuild' | 'onModelChange'
> {
  persistModelChanges?: boolean
  configPath?: string
  config?: CliConfigStore
  requestSetup?: RequestSetup
}

interface ControllerRequest extends Omit<RuntimeBackendRequest, 'peerEndpointId'> {
  peerEndpointId?: string
  settings?: Partial<ChatSettings>
}

export async function createInteractiveChat(
  options: CreateInteractiveChatOptions = {},
  conversations?: ChatConversations,
  conversationId = conversations?.activeId
): Promise<ConversationManager> {
  const initialWorkspace = resolve(options.cwd ?? process.cwd())
  const configuredSessionSettings = sessionSettings(options.agentOptions?.session)
  const initialSessionDirectory = resolve(initialWorkspace, configuredSessionSettings.dir ?? DEFAULT_SESSION_DIR)
  const configuredSessionId = configuredSessionSettings.id
  // A `SessionManager` instance on `session` is honored like the SDK's `sessionManager`.
  const configuredSessionManager = options.agentOptions?.sessionManager ?? configuredSessionSettings.manager
  const config = options.config ?? (await CliConfigStore.load(options.configPath))
  const agentMessaging = new AgentMessaging()
  const owner = await createInteractiveRuntime({
    ...options,
    config,
    agentMessaging,
    configurationEnabled: options.requestSetup !== undefined,
    onModelChange: async (change): Promise<void> => {
      if (options.persistModelChanges !== false) await config.setProfileModel(change.model, change.effort)
    },
  })
  const controllerContexts = new WeakMap<ChatController, { workspace: string; sessionDirectory: string }>()
  const runtimes = new Set<AgentModelRuntime>()
  let nextPeerEndpoint = 1
  for (const entry of conversations?.entries ?? []) {
    nextPeerEndpoint = Math.max(nextPeerEndpoint, Number(entry.id.slice('agent-'.length)) + 1)
  }

  const createController = async (
    request: ControllerRequest,
    conversation?: ChatConversation
  ): Promise<ChatController> => {
    const peerEndpointId = request.peerEndpointId ?? `agent-${nextPeerEndpoint++}`
    const workspace = resolve(request.workspace)
    const sessionDirectory = resolve(request.sessionDirectory)
    const configSnapshot = config.snapshot()
    let resetConfigurationPreview: (() => void) | undefined
    let stopConfigurationWatch: (() => void) | undefined
    const {
      runtime,
      backend,
      mcp,
      skills,
      sessions,
      configuration,
      profile: currentProfile,
    } = await owner.createBackend(
      {
        ...request,
        peerEndpointId,
        onConfigurationDiscard: (): void => resetConfigurationPreview?.(),
        onDispose: (): void => stopConfigurationWatch?.(),
      },
      conversation
    )
    try {
      const { name: sessionName, agentName } = await restoreSessionNames(sessions, conversation)
      const controller = new ChatController(backend, {
        runtime: {
          version: HARNESS_VERSION,
          session: sessionName ?? runtime.sessionId ?? (request.sessionManager !== undefined ? 'managed' : 'in-memory'),
          ...(sessionName ? { sessionName } : {}),
          ...(agentName ? { agent: agentName } : {}),
          cwd: workspace,
        },
        settings: { ...configSnapshot.settings, ...request.settings },
        sessions,
        skills,
        mcp,
        streamPresentation: DEFAULT_STREAM_PRESENTATION,
        initialMessages: runtime.agent.messages,
        ...(conversation ? { initialTurns: conversation.completedTurns } : {}),
        ...(conversation?.configurationBaseline
          ? { initialConfigurationBaseline: conversation.configurationBaseline }
          : {}),
        setSettings: (settings): Promise<void> => config.setSettings(settings),
        ...(options.project ? { project: options.project } : {}),
        exportAgentProject: (language, destination, output): Promise<string | undefined> => {
          if (options.project) {
            const privatePaths = agentPrivatePaths(runtime.agent)
            return exportSourceProject(
              options.project,
              runtime.agent.name,
              language,
              privatePaths === null ? null : [sessionDirectory, ...privatePaths],
              destination,
              output
            )
          }
          const profile = configuration?.profile() ?? currentProfile()
          const baseDir = configSnapshot.profileBaseDir ?? initialWorkspace
          return exportAgentProject(
            profile,
            language,
            resolveSkillPaths(
              typeof profile.skills === 'object' ? [...profile.skills] : profile.skills,
              baseDir,
              false
            ),
            baseDir,
            destination,
            output
          )
        },
        ...(configuration
          ? {
              configurationSource: (): ChatConfigurationSource =>
                configurationSource(
                  configuration.profile(),
                  options.project,
                  configSnapshot.profileBaseDir ?? initialWorkspace
                ),
            }
          : {}),
        ...(options.requestSetup
          ? {
              requestSetup: options.requestSetup,
              awsProfile: awsProfileSelection(
                config,
                options.requestSetup,
                peerEndpointId,
                options.project?.entrypoint,
                options.project ? undefined : currentProfile
              ),
              useExportedProject: (path: string): void =>
                options.requestSetup?.({ agentProject: path, conversationId: peerEndpointId }),
            }
          : {}),
        ...(options.requestSetup && !options.project
          ? {
              builtinTools: createBuiltinToolsRuntime(currentProfile, options.requestSetup, peerEndpointId),
            }
          : {}),
        peerEndpointId,
      })
      resetConfigurationPreview = (): void => controller.refreshConfiguration(true)
      if (configuration) {
        stopConfigurationWatch = controller.subscribe(() => {
          if (controller.busy) return
          const snapshot = controller.getSnapshot()
          const complete = snapshot.completedTurns.at(-1)?.status === 'complete'
          if (complete && snapshot.tasks.some(isUnresolvedBackgroundTask)) return
          const change = configuration.takePending()
          if (!change) return
          if (complete) {
            options.requestSetup?.({ ...change, conversationId: peerEndpointId })
          } else {
            const message =
              'The turn did not complete, so the configuration was not applied. The previous agent remains active. ' +
              'Ask the agent to apply the draft again when ready.'
            controller.showError('Setup not applied', message)
            void change.onFailure?.(message).catch((error: unknown) => {
              controller.showError(
                'Setup not applied',
                `${message}\nCould not save this notice: ${errorMessage(error)}`
              )
            })
          }
        })
      }
      agentMessaging.register({
        id: peerEndpointId,
        name: peerEndpointId,
        status: () => (controller.backend.streamPeer === undefined ? undefined : controller.busy ? 'working' : 'idle'),
        enqueue: (message): boolean => controller.enqueuePeerMessage(message),
      })
      controllerContexts.set(controller, { workspace, sessionDirectory })
      runtimes.add(runtime)
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
        const session = entry.conversation.session
        const preserveSession =
          session &&
          (entry.id !== conversationId ||
            (session.configured.sessionId === (configuredSessionId ?? null) &&
              session.configured.sessionDir === initialSessionDirectory))
        const controller = await createController(
          {
            peerEndpointId: entry.id,
            workspace: entry.conversation.workspace,
            sessionDirectory: preserveSession ? session.sessionDirectory : initialSessionDirectory,
            ...(preserveSession
              ? { sessionId: session.sessionId }
              : configuredSessionId
                ? { sessionId: configuredSessionId }
                : {}),
            ...(entry.id === 'agent-1' && configuredSessionManager !== undefined
              ? { sessionManager: configuredSessionManager }
              : {}),
            ...(!options.project && entry.id !== conversationId && entry.conversation.selection
              ? { selection: entry.conversation.selection }
              : {}),
          },
          entry.conversation
        )
        entries.push({
          id: entry.id,
          title: controller.name,
          description: entry.description,
          controller,
        })
      }
    } else {
      const primary = await createController({
        workspace: initialWorkspace,
        sessionDirectory: initialSessionDirectory,
        ...(configuredSessionId ? { sessionId: configuredSessionId } : {}),
        ...(configuredSessionManager !== undefined ? { sessionManager: configuredSessionManager } : {}),
      })
      entries.push({
        id: 'agent-1',
        title: primary.name,
        description: primary.backend.info?.().description || 'Primary agent',
        controller: primary,
      })
    }
    const project = options.project
    return new ConversationManager(
      { activeId: conversations?.activeId ?? 'agent-1', entries },
      {
        fork: async (source): Promise<ChatController> => {
          const seed = source.backend.forkState?.()
          const context = controllerContexts.get(source)
          if (!seed || !context) {
            throw new Error('Only Strands-backed conversations can be forked.')
          }
          const stash = await source.backend.forkStash?.()
          return createController({
            workspace: context.workspace,
            sessionDirectory: context.sessionDirectory,
            seed: { ...seed, ...(stash && { stash }) },
            settings: source.getSnapshot().settings,
          })
        },
        resume: async (source, target: SessionTarget): Promise<ChatController> => {
          const seed = source.backend.forkState?.()
          if (!seed) {
            throw new Error('Only Strands-backed conversations can open saved sessions.')
          }
          return createController({
            workspace: target.workspace,
            sessionDirectory: target.sessionDirectory,
            sessionId: target.sessionId,
            seed,
            restoreSeedMessages: false,
            settings: source.getSnapshot().settings,
          })
        },
        dispose: owner.dispose,
        agentMessaging,
        voice: new PythonVoiceSession({ cwd: initialWorkspace }),
        ...(project && options.requestSetup
          ? {
              project,
              projectPrivatePaths: [...runtimes].some((runtime) => agentPrivatePaths(runtime.agent) === null)
                ? null
                : [
                    initialSessionDirectory,
                    ...[...runtimes].flatMap((runtime) =>
                      (agentPrivatePaths(runtime.agent) ?? []).map((path) => resolve(initialWorkspace, path))
                    ),
                  ],
              reloadProject: (conversationId: string, paths: readonly string[]): void =>
                options.requestSetup?.({ agentProject: project.entrypoint, conversationId, reloadedFiles: paths }),
            }
          : {}),
      }
    )
  } catch (error) {
    await Promise.allSettled(entries.map(({ controller }) => controller.dispose()))
    await owner.dispose()
    throw error
  }
}

function awsProfileSelection(
  config: CliConfigStore,
  requestSetup: RequestSetup,
  conversationId?: string,
  agentProject?: string,
  currentProfile?: () => HarnessAgentConfig
): NonNullable<ChatControllerOptions['awsProfile']> {
  return {
    get: (): ReturnType<NonNullable<ChatControllerOptions['awsProfile']>['get']> => {
      const environment = config.providerEnvironment()
      const value = config.configuredProviderEnvironment().AWS_PROFILE ?? ''
      const aws = discoverAwsConfiguration({
        AWS_CONFIG_FILE: environment.AWS_CONFIG_FILE?.value,
        AWS_SHARED_CREDENTIALS_FILE: environment.AWS_SHARED_CREDENTIALS_FILE?.value,
      })
      return {
        value,
        options: [
          { value: '', label: 'Environment/default' },
          ...[...new Set([...aws.profiles, ...(environment.AWS_PROFILE ? [environment.AWS_PROFILE.value] : [])])].map(
            (profile) => ({
              value: profile,
              label: profile,
            })
          ),
        ],
      }
    },
    select: (profile): void => {
      const configuration = configurationFromStore(config)
      if (profile) configuration.providerEnvironment.AWS_PROFILE = profile
      else delete configuration.providerEnvironment.AWS_PROFILE
      requestSetup({
        configuration,
        ...(currentProfile ? { profile: currentProfile() } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(agentProject ? { agentProject } : {}),
      })
    },
  }
}
