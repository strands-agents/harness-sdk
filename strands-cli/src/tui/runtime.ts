import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createHarness, type HarnessAgentConfig, type HarnessAgentOptions } from '@strands-agents/harness'
import { resolveInterventions } from '@strands-agents/harness/internal'
import type { Message, Agent, Tool } from '@strands-agents/sdk'
import { Offload } from '@strands-agents/sdk/experimental'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins'
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'

import { createBuiltinToolsRuntime, createConfigurationTool, type RequestSetup } from './agent-configuration.js'
import { configurationSource } from './configuration-source.js'
import { CONFIGURATION_INSTRUCTIONS } from './configuration-instructions.js'
import { agentPrivatePaths, exportAgentProject, exportSourceProject } from './project/export.js'
import type { ImportedAgentProject } from './project/import.js'
import type { AgentFactory } from './project/typescript.js'
import { BackgroundAgentActivityStore, observeSubagentActivity } from './background/activity.js'
import { BackgroundAgentInbox } from './background/inbox.js'
import {
  ChatController,
  type ChatConfigurationSource,
  type ChatConversation,
  type ChatConversations,
  type ChatDiffPreview,
  type ChatForkState,
  type ChatSettings,
  type ContextOffloadThreshold,
} from './chat/controller.js'
import { isUnresolvedBackgroundTask } from './chat/controller-helpers.js'
import { ConversationManager, type InitialConversations } from './session/conversations.js'
import { CliConfigStore, type ProfileEffort, type RuntimeConfig } from './config.js'
import { loadMcp, type LoadedMcp, type LoadMcpOptions } from './mcp.js'
import { AgentMessaging, peerMessagePrompt, type PeerMessageRouter } from './messaging.js'
import { AgentModelRuntime } from './model/runtime.js'
import { profileEffort } from './model/selection.js'
import { sessionSettings, withSession } from './session/options.js'
import { HARNESS_VERSION } from './package-version.js'
import { CedarPermissions, ToolPermissionBroker } from './permissions/policy.js'
import { discoverContextWindow, discoverProviderModels } from './provider/discovery.js'
import { requireBedrockRegion } from './provider/aws-config.js'
import { rethrowWithProviderHint } from './provider/packages.js'
import { upgradeDesktopAgentProfileMessages } from './session/desktop-profile.js'
import {
  initializeAgentDefinition,
  persistSessionAgentDefinition,
  restoreSessionAgentDefinition,
} from './session/agent-definition.js'
import { DEFAULT_SESSION_DIR, FileSessionRuntime, SessionRootCatalog, type SessionTarget } from './session/sessions.js'
import { AgentSkillsRuntime, resolveSkillPaths, resolveSkillSources } from './skills.js'
import { StrandsChatBackend } from './strands-backend.js'
import { LiveSteering } from './steering.js'
import { DEFAULT_STREAM_PRESENTATION } from './stream-presentation.js'
import { graphemes } from './terminal/composer.js'
import { errorMessage } from './terminal/sanitize.js'
import { PythonVoiceSession } from './voice/session.js'
import { inspectWorkspaceMcp, isWorkspaceMcpTrusted } from './workspace/trust.js'
import { WorkspaceSandbox } from './workspace/sandbox.js'

interface CreateInteractiveChatOptions {
  agentOptions?: HarnessAgentOptions
  agentProfile?: HarnessAgentConfig
  buildAgent?: AgentFactory
  project?: ImportedAgentProject
  persistModelChanges?: boolean
  cwd?: string
  mcpPaths?: readonly string[]
  mcpStrictPaths?: readonly string[]
  mcpDigests?: Readonly<Record<string, string>>
  configPath?: string
  config?: CliConfigStore
  /** Directory holding the built-in agent's per-workspace session directories; defaults to `~/.strands/sessions`. */
  sessionRoot?: string
  requestSetup?: RequestSetup
}

/** @internal */
export interface CreateInteractiveRuntimeOptions extends Omit<
  CreateInteractiveChatOptions,
  'config' | 'configPath' | 'persistModelChanges' | 'requestSetup'
> {
  config: RuntimeConfig
  agentMessaging?: AgentMessaging
  peerMessageRouter?: PeerMessageRouter
  configurationEnabled?: boolean
  allowRebuild?: boolean
  onModelChange?: (change: { model: string; effort: ProfileEffort }) => Promise<void> | void
}

/** @internal */
export interface RuntimeBackendRequest {
  workspace: string
  sessionDirectory: string
  sessionId?: string
  sessionManager?: HarnessAgentOptions['sessionManager']
  seed?: ChatForkState
  restoreSeedMessages?: boolean
  peerEndpointId: string
  selection?: ChatConversation['selection']
  onConfigurationDiscard?: () => void
  onDispose?: () => void
}

interface ControllerRequest extends Omit<RuntimeBackendRequest, 'peerEndpointId'> {
  peerEndpointId?: string
  settings?: Partial<ChatSettings>
}

/** @internal */
export interface InteractiveRuntimeBackend {
  runtime: AgentModelRuntime
  backend: StrandsChatBackend
  mcp: LoadedMcp
  skills: AgentSkillsRuntime
  sessions: FileSessionRuntime
  configuration?: ReturnType<typeof createConfigurationTool>
  profile(): HarnessAgentConfig
}

/** @internal */
export interface InteractiveRuntime {
  createBackend(request: RuntimeBackendRequest, conversation?: ChatConversation): Promise<InteractiveRuntimeBackend>
  dispose(): Promise<void>
}

/** @internal */
export async function createInteractiveRuntime(options: CreateInteractiveRuntimeOptions): Promise<InteractiveRuntime> {
  const initialWorkspace = resolve(options.cwd ?? process.cwd())
  const configuredSessionSettings = sessionSettings(options.agentOptions?.session)
  const initialSessionDirectory = resolve(initialWorkspace, configuredSessionSettings.dir ?? DEFAULT_SESSION_DIR)
  const sessionCatalog = await loadSessionCatalog(options.sessionRoot)
  const config = options.config
  const launchSettings = config.snapshot().settings
  const configuredInterventions = await resolveInterventions(options.agentOptions?.interventions)
  const configuredSessionId = configuredSessionSettings.id
  const {
    interventions: _interventions,
    session: _session,
    sessionManager: _sessionManager,
    sandbox: configuredSandbox,
    mcpServers: configuredMcpServers,
    ...portableAgentOptions
  } = options.agentOptions ?? {}
  const sourceDefinition =
    options.project && typeof portableAgentOptions.model === 'string'
      ? {
          source: options.project.entrypoint,
          configured: {
            model: portableAgentOptions.model,
            thinking: portableAgentOptions.effort ?? 'auto',
          },
        }
      : undefined
  const agentMessaging = options.agentMessaging ?? new AgentMessaging()
  const subagentToolsByAgent = new Map<Agent, Tool>()
  const stopObservingSubagents = new Map<Tool, () => void>()
  const agents = new Set<Agent>()
  const backends = new Set<StrandsChatBackend>()
  const skillsByAgent = new WeakMap<Agent, AgentSkills>()
  let nextBackgroundEndpoint = 1
  let disposed = false
  let disposal: Promise<void> | undefined

  const releaseAgent = (candidate: Agent): void => {
    agentMessaging.unbindAgent(candidate)
    agents.delete(candidate)
    const subagentTool = subagentToolsByAgent.get(candidate)
    subagentToolsByAgent.delete(candidate)
    if (subagentTool && ![...subagentToolsByAgent.values()].includes(subagentTool)) {
      stopObservingSubagents.get(subagentTool)?.()
      stopObservingSubagents.delete(subagentTool)
    }
  }

  const disposeFailedAgent = async (candidate: Agent): Promise<void> => {
    candidate.cancel()
    releaseAgent(candidate)
    await Promise.allSettled([candidate.memoryManager?.flush()])
  }

  const buildAgent = async (
    controllerOptions: HarnessAgentOptions,
    configuredTools: NonNullable<HarnessAgentOptions['tools']>,
    peerEndpointId: string,
    backgroundActivity: BackgroundAgentActivityStore,
    overrides: Partial<HarnessAgentOptions>,
    workspace: string
  ): Promise<Agent> => {
    if (disposed) {
      throw new Error('Runtime is disposed.')
    }
    const agentOptions = { ...controllerOptions, ...overrides }
    const resolvedAgentOptions = options.project
      ? agentOptions
      : withContextOffloadThreshold(agentOptions, launchSettings.contextOffloadThreshold)
    requireBedrockRegion(resolvedAgentOptions.model)
    let skills: AgentSkills | undefined
    const prepareOptions = (configured: HarnessAgentOptions): HarnessAgentOptions => {
      skills = configured.plugins?.find((plugin): plugin is AgentSkills => plugin instanceof AgentSkills)
      if (skills) return configured
      if (configured.skills instanceof AgentSkills) {
        skills = configured.skills
      } else {
        const sources = resolveSkillSources(configured.skills, workspace, config.snapshot().settings.skillDiscovery)
        skills = sources.length > 0 ? new AgentSkills({ skills: sources }) : undefined
      }
      return { ...configured, skills: skills ?? false }
    }
    const configured: HarnessAgentOptions = {
      ...resolvedAgentOptions,
      tools: [...configuredTools],
      plugins: [
        ...(agentOptions.plugins ?? []),
        ...(options.configurationEnabled
          ? [
              new ContextInjector({
                name: 'strands:configuration-awareness',
                renderContent: async ({ agent }): Promise<string> =>
                  `Your current configured name is ${JSON.stringify((agent as Agent).name)}. When stating your own name, use this ` +
                  `name instead of names in earlier conversation or memory.\n\n${CONFIGURATION_INSTRUCTIONS}`,
              }),
            ]
          : []),
        ...(config.snapshot().settings.agentMessaging
          ? [agentMessaging.createPlugin(peerEndpointId, options.peerMessageRouter)]
          : []),
      ],
      backgroundTasks: interactiveBackgroundTasks(agentOptions),
      printer: false,
    }
    const agent = await (
      options.buildAgent ? options.buildAgent(configured, prepareOptions) : createHarness(prepareOptions(configured))
    ).catch(rethrowWithProviderHint)
    try {
      if (disposed) throw new Error('Runtime was disposed while building an agent.')
      await initializeAgentDefinition(agent)
      agent.messages = upgradeDesktopAgentProfileMessages(agent.messages)
      await persistSessionAgentDefinition(agentOptions)
      if (disposed) throw new Error('Runtime was disposed while building an agent.')
      agents.add(agent)
      if (skills) skillsByAgent.set(agent, skills)
      const subagentTool = agent.toolRegistry.get('subagent')
      if (subagentTool) {
        subagentToolsByAgent.set(agent, subagentTool)
        if (!stopObservingSubagents.has(subagentTool)) {
          stopObservingSubagents.set(subagentTool, observeSubagentActivity(subagentTool, backgroundActivity))
        }
      }
      return agent
    } catch (error) {
      await disposeFailedAgent(agent)
      throw error
    }
  }

  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    disposal = (async (): Promise<void> => {
      await Promise.allSettled([...backends].map((backend) => backend.dispose()))
      await Promise.allSettled([...agents].map((agent) => agent.memoryManager?.flush()))
      for (const stop of stopObservingSubagents.values()) stop()
      stopObservingSubagents.clear()
      agents.clear()
      subagentToolsByAgent.clear()
    })()
    return disposal
  }

  const createBackend = async (
    request: RuntimeBackendRequest,
    conversation?: ChatConversation
  ): Promise<InteractiveRuntimeBackend> => {
    if (disposed) throw new Error('Runtime is disposed.')
    const peerEndpointId = request.peerEndpointId
    const sourceSelection = conversation?.sourceSelection
    const selection =
      sourceDefinition &&
      sourceSelection?.source === sourceDefinition.source &&
      sourceSelection.configured.model === sourceDefinition.configured.model &&
      sourceSelection.configured.thinking === sourceDefinition.configured.thinking
        ? sourceSelection.selected
        : request.selection
    const selectedAgentOptions = selection
      ? { ...portableAgentOptions, model: selection.model, effort: profileEffort(selection.thinking) }
      : portableAgentOptions
    const backgroundInbox = new BackgroundAgentInbox()
    const backgroundActivity = new BackgroundAgentActivityStore(backgroundInbox)
    const backgroundEndpointIds = new Map<string, string>()
    backgroundInbox.subscribe((event) => {
      if (event.type === 'unavailable') {
        const endpointId = backgroundEndpointIds.get(event.taskId)
        if (endpointId) {
          backgroundEndpointIds.delete(event.taskId)
          agentMessaging.unregister(endpointId)
        }
        return
      }
      const endpoint = event.endpoint
      const endpointId = `task-${nextBackgroundEndpoint++}`
      backgroundEndpointIds.set(endpoint.taskId, endpointId)
      const summary = endpoint.task.replace(/\s+/g, ' ').trim()
      agentMessaging.register({
        id: endpointId,
        name: summary ? `${endpoint.name}: ${graphemes(summary).slice(0, 80).join('')}` : endpoint.name,
        status: () => 'working',
        enqueue: (message): boolean => backgroundInbox.send(endpoint.taskId, peerMessagePrompt(message)),
      })
    })
    const workspace = resolve(request.workspace)
    const sessionDirectory = resolve(request.sessionDirectory)
    // A disabled session (`--session off`) keeps the interactive run ephemeral: no id is minted, so
    // no session state is persisted. `undefined` leaves the default on. Matches the harness's toggle.
    const sessionEnabled = configuredSessionSettings.enabled
    const sessionId = sessionEnabled
      ? (request.sessionId ?? (request.sessionManager === undefined ? createInteractiveSessionId() : undefined))
      : undefined
    if (sessionEnabled) await registerSessionRoot(sessionCatalog, sessionDirectory, workspace)

    const baseAgentOptions: HarnessAgentOptions = sessionEnabled
      ? withSession(selectedAgentOptions, { id: sessionId, dir: sessionDirectory })
      : { ...selectedAgentOptions, session: false }
    const restoredAgentOptions = options.project
      ? baseAgentOptions
      : await restoreSessionAgentDefinition(baseAgentOptions, workspace)
    const sandbox =
      configuredSandbox === undefined || configuredSandbox === false
        ? new WorkspaceSandbox(workspace)
        : configuredSandbox
    const loadedMcp = await loadMcp({
      ...(await workspaceMcpOptions(options, initialWorkspace, workspace, config.snapshot().settings.mcpDiscovery)),
      ...(configuredMcpServers ? { servers: configuredMcpServers } : {}),
      backgroundConnect: true,
      disabledServers: config.snapshot().settings.disabledMcpServers,
    })
    let mcpDisposal: Promise<void> | undefined
    const mcp: LoadedMcp = {
      ...loadedMcp,
      dispose: (): Promise<void> => (mcpDisposal ??= loadedMcp.dispose()),
    }
    const configuredTools: NonNullable<HarnessAgentOptions['tools']> = [
      ...(restoredAgentOptions.tools ?? []),
      ...mcp.clients,
    ]
    const permissionBroker = new ToolPermissionBroker()
    const cedarPermissions = new CedarPermissions({
      broker: permissionBroker,
      config,
      cwd: workspace,
      configurationPreview: (): ChatDiffPreview | undefined => configuration?.preview(),
      configurationDenied: (revision): void => {
        if (configuration?.discard(revision)) request.onConfigurationDiscard?.()
      },
    })
    const liveSteering: LiveSteering = new LiveSteering((candidate) => {
      return backgroundInbox.observeAgent((prompt): boolean => liveSteering.enqueue(candidate, prompt))
    })
    const controllerOptions: HarnessAgentOptions = {
      ...withSession(restoredAgentOptions, { id: sessionId, dir: sessionDirectory }),
      ...(request.seed ? { model: request.seed.model, effort: profileEffort(request.seed.thinking) } : {}),
      ...(request.sessionManager !== undefined ? { sessionManager: request.sessionManager } : {}),
      sandbox,
      interventions: [liveSteering, cedarPermissions, ...configuredInterventions],
    }
    // Exported source factories retain authored options unless the override contains the key.
    if (configuredMcpServers) Reflect.set(controllerOptions, 'mcpServers', undefined)

    const configSnapshot = config.snapshot()
    let exportProfile = {
      ...(options.agentProfile ?? configSnapshot.profile),
      ...(typeof controllerOptions.model === 'string' ? { model: controllerOptions.model, modelModule: null } : {}),
      effort: controllerOptions.effort ?? 'auto',
    }
    let agent: Agent | undefined
    const configuration = options.configurationEnabled
      ? createConfigurationTool({
          config,
          profile: (): HarnessAgentConfig => exportProfile,
          agent: (): Agent | undefined => agent,
          ...(options.project ? { source: options.project.entrypoint } : {}),
        })
      : undefined
    if (configuration) configuredTools.push(configuration.tool)
    try {
      agent = await buildAgent(controllerOptions, configuredTools, peerEndpointId, backgroundActivity, {}, workspace)
      if (request.seed && request.restoreSeedMessages !== false) {
        agent.messages = [...request.seed.messages]
        // The fork has its own session id, so the `[ref: …]` in the copied messages resolve only against a
        // copy of the source's stash.
        if (request.seed.stash) await agent.contextManager?.stash?.loadSnapshot(request.seed.stash)
        await agent.sessionManager?.saveSnapshot({
          target: agent,
          isLatest: true,
        })
      }
      if (conversation) {
        agent.loadSnapshot(conversation.snapshot)
        agent.messages = cloneConversation(agent.messages, conversation.model === agent.model.modelId)
        await agent.sessionManager?.saveSnapshot({ target: agent, isLatest: true })
      }
      if (disposed) throw new Error('Runtime was disposed while building an agent.')

      const runtime = new AgentModelRuntime(agent, {
        ...(typeof controllerOptions.model === 'string' ? { initialModel: controllerOptions.model } : {}),
        providers: configSnapshot.providers.enabled,
        providerEnvironment: config.providerEnvironment(),
        discoverProviderModels,
        discoverContextWindow,
        thinking: controllerOptions.effort,
        ...(sessionId ? { sessionId: agent.sessionManager?.sessionId ?? sessionId } : {}),
        sessionDir: sessionDirectory,
        ...(options.allowRebuild !== false && sessionEnabled && request.sessionManager === undefined
          ? { newSessionId: createInteractiveSessionId }
          : {}),
        onModelChange: async (change): Promise<void> => {
          exportProfile = {
            ...exportProfile,
            model: change.model,
            effort: change.effort,
            modelModule: change.model === exportProfile.model ? exportProfile.modelModule : null,
          }
          await options.onModelChange?.(change)
        },
        ...(options.allowRebuild === false
          ? {}
          : {
              restartAgent: async (restartRequest, previousAgent): Promise<Agent> => {
                if (!restartRequest.preserveConversation && request.sessionManager !== undefined) {
                  throw new Error(
                    'The custom session manager owns this session. Start a new session in the agent configuration.'
                  )
                }
                let nextAgent: Agent | undefined
                try {
                  await previousAgent.memoryManager?.flush()
                  const overrides: Partial<HarnessAgentOptions> = {
                    model: restartRequest.model,
                    effort: profileEffort(restartRequest.thinking),
                    ...(restartRequest.sessionId !== undefined || restartRequest.sessionDir
                      ? {
                          session: withSession(controllerOptions, {
                            ...(restartRequest.sessionId !== undefined
                              ? { id: restartRequest.sessionId ?? undefined }
                              : {}),
                            ...(restartRequest.sessionDir ? { dir: restartRequest.sessionDir } : {}),
                          }).session,
                        }
                      : {}),
                  }
                  nextAgent = await buildAgent(
                    controllerOptions,
                    configuredTools,
                    peerEndpointId,
                    backgroundActivity,
                    overrides,
                    workspace
                  )
                  if (restartRequest.preserveConversation) {
                    nextAgent.messages = cloneConversation(
                      previousAgent.messages,
                      restartRequest.preserveReasoning !== false
                    )
                  }
                } catch (error) {
                  if (nextAgent) {
                    await disposeFailedAgent(nextAgent)
                  }
                  throw error
                }
                releaseAgent(previousAgent)
                agent = nextAgent
                return nextAgent
              },
            }),
      })

      const backend = new StrandsChatBackend(runtime, {
        ...(sourceDefinition ? { sourceDefinition } : {}),
        sessionIdentity: (): ChatConversation['session'] =>
          sessionEnabled && request.sessionManager === undefined && runtime.sessionId
            ? {
                sessionId: runtime.sessionId,
                sessionDirectory: runtime.sessionDirectory,
                workspace,
                configured: { sessionId: configuredSessionId ?? null, sessionDir: initialSessionDirectory },
              }
            : undefined,
        contextWindow: (): Promise<number | undefined> => runtime.contextWindow(),
        taskActivity: backgroundActivity,
        permissions: { broker: permissionBroker, policy: cedarPermissions },
        steering: liveSteering,
        contextScope: workspace,
        dispose: (): void => {
          request.onDispose?.()
          agentMessaging.unregister(peerEndpointId)
          backgroundInbox.dispose()
        },
      })
      const sessions = new FileSessionRuntime(runtime, sessionDirectory, {
        ...(sessionCatalog ? { catalog: sessionCatalog } : {}),
        workspace,
        currentSessionResumable: sessionEnabled && request.sessionManager === undefined,
      })
      const skills = new AgentSkillsRuntime(
        () => runtime.agent,
        (agent) => skillsByAgent.get(agent)
      )
      const disposeBackend = backend.dispose.bind(backend)
      let backendDisposal: Promise<void> | undefined
      // The controller and owner may both dispose this backend.
      backend.dispose = (): Promise<void> => {
        backendDisposal ??= (async (): Promise<void> => {
          await Promise.allSettled([
            disposeBackend(),
            mcp.dispose(),
            Promise.resolve().then(() => runtime.agent.memoryManager?.flush()),
          ])
          releaseAgent(runtime.agent)
          backends.delete(backend)
        })()
        return backendDisposal
      }
      backends.add(backend)
      return {
        runtime,
        backend,
        mcp,
        skills,
        sessions,
        ...(configuration ? { configuration } : {}),
        profile: () => exportProfile,
      }
    } catch (error) {
      permissionBroker.dispose()
      if (agent) {
        await disposeFailedAgent(agent)
      }
      backgroundInbox.dispose()
      await mcp.dispose()
      throw error
    }
  }

  return { createBackend, dispose }
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
      const sessionName = sessions.current ? (await sessions.resolve(sessions.current)).name : undefined
      const controller = new ChatController(backend, {
        runtime: {
          version: HARNESS_VERSION,
          session: sessionName ?? runtime.sessionId ?? (request.sessionManager !== undefined ? 'managed' : 'in-memory'),
          ...(sessionName ? { sessionName } : {}),
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
            return exportSourceProject(
              options.project,
              runtime.agent.name,
              language,
              [sessionDirectory, ...agentPrivatePaths(runtime.agent)],
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
        entries.push({ id: entry.id, title: entry.title, description: entry.description, controller })
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
        title: primary.backend.name,
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
              projectPrivatePaths: [
                initialSessionDirectory,
                ...[...runtimes].flatMap((runtime) =>
                  agentPrivatePaths(runtime.agent).map((path) => resolve(initialWorkspace, path))
                ),
              ],
              reloadProject: (conversationId: string): void =>
                options.requestSetup?.({ agentProject: project.entrypoint, conversationId }),
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

function withContextOffloadThreshold(
  options: HarnessAgentOptions,
  threshold: ContextOffloadThreshold
): HarnessAgentOptions {
  const contextManager = options.contextManager
  if (
    threshold === 'default' ||
    (contextManager !== undefined && contextManager !== 'auto' && contextManager !== 'agentic')
  ) {
    return options
  }
  const summarizeUtilization = contextManager === 'agentic' ? 1 : 0.85
  return {
    ...options,
    contextManager: {
      strategies: [
        Offload.truncate('toolResults', { previewTokens: 750 }).when({ threshold }),
        Offload.summarize('*').when({ utilization: summarizeUtilization, preserveRecent: 4 }),
      ],
    },
  }
}

/** @internal */
export function cloneConversation(messages: readonly Message[], preserveReasoning: boolean): Message[] {
  return messages.flatMap((message) => {
    const clone = message.clone()
    if (!preserveReasoning) {
      for (let index = clone.content.length - 1; index >= 0; index--) {
        if (clone.content[index]!.type === 'reasoningBlock') {
          clone.content.splice(index, 1)
        }
      }
    }
    return clone.content.length > 0 ? [clone] : []
  })
}

function createInteractiveSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'z')
    .toLowerCase()
  return `${timestamp}-${randomUUID().slice(0, 8)}`
}

export function interactiveBackgroundTasks(
  options: HarnessAgentOptions
): Exclude<HarnessAgentOptions['backgroundTasks'], undefined> {
  const configured = options.backgroundTasks
  if (configured === false) {
    return false
  }
  return { ...(configured === true ? {} : configured), waitForCompletion: false }
}

async function loadSessionCatalog(root: string | undefined): Promise<SessionRootCatalog | undefined> {
  try {
    return await SessionRootCatalog.load(root)
  } catch {
    return undefined
  }
}

async function registerSessionRoot(
  catalog: SessionRootCatalog | undefined,
  sessionDirectory: string,
  workspace: string
): Promise<void> {
  try {
    await catalog?.register(sessionDirectory, workspace)
  } catch {
    // Session persistence still works when the optional global catalog is unavailable.
  }
}

async function workspaceMcpOptions(
  options: Pick<CreateInteractiveChatOptions, 'mcpPaths' | 'mcpStrictPaths' | 'mcpDigests'>,
  initialWorkspace: string,
  workspace: string,
  discovery: boolean
): Promise<LoadMcpOptions> {
  if (options.mcpPaths === undefined) {
    return { cwd: workspace, ...(discovery ? {} : { paths: [] }) }
  }
  if (workspace === initialWorkspace) {
    return {
      cwd: workspace,
      paths: options.mcpPaths,
      ...(options.mcpStrictPaths ? { strictPaths: options.mcpStrictPaths } : {}),
      ...(options.mcpDigests ? { expectedDigests: options.mcpDigests } : {}),
    }
  }

  const initialProjectPaths = new Set(Object.keys(options.mcpDigests ?? {}))
  const paths = options.mcpPaths.filter((path) => !initialProjectPaths.has(path))
  const strictPaths = options.mcpStrictPaths?.filter((path) => paths.includes(path))
  const inheritedStrictPaths = strictPaths && strictPaths.length > 0 ? { strictPaths } : {}
  if (options.mcpPaths.length === 0) {
    return { cwd: workspace, paths, ...inheritedStrictPaths }
  }

  const inspection = await inspectWorkspaceMcp(workspace)
  if (!inspection || !(await isWorkspaceMcpTrusted(inspection))) {
    return { cwd: workspace, paths, ...inheritedStrictPaths }
  }
  return {
    cwd: workspace,
    paths: [...new Set([...paths, ...inspection.paths])],
    ...inheritedStrictPaths,
    expectedDigests: inspection.digests,
  }
}
