import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createHarness, type HarnessAgentConfig, type HarnessAgentOptions } from '@strands-agents/harness'
import { resolveInterventions } from '@strands-agents/harness/internal'
import type { Message, Agent, Tool } from '@strands-agents/sdk'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins'
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'

import { createConfigurationTool, type RequestSetup } from './agent-configuration.js'
import { CONFIGURATION_INSTRUCTIONS } from './configuration-instructions.js'
import { exportAgentProject, exportSourceProject } from './project/export.js'
import type { ImportedAgentProject } from './project/import.js'
import type { AgentFactory } from './project/typescript.js'
import { BackgroundAgentActivityStore, observeSubagentActivity } from './background/activity.js'
import { BackgroundAgentInbox } from './background/inbox.js'
import {
  ChatController,
  type ChatConversation,
  type ChatDiffPreview,
  type ChatForkState,
  type ChatSettings,
} from './chat/controller.js'
import { isUnresolvedBackgroundTask } from './chat/controller-helpers.js'
import { ConversationManager } from './session/conversations.js'
import { CliConfigStore, type SetupConfiguration } from './config.js'
import { loadMcp, type LoadMcpOptions } from './mcp.js'
import { memoryDirectory } from './memory-options.js'
import { AgentMessaging, peerMessagePrompt } from './messaging.js'
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
import { configuredSkillPaths, FileSkillsRuntime, resolveSkillPaths, type SkillPathsOption } from './skills.js'
import { StrandsChatBackend } from './strands-backend.js'
import { LiveSteering } from './steering.js'
import { DEFAULT_STREAM_PRESENTATION } from './stream-presentation.js'
import { errorMessage } from './terminal/sanitize.js'
import { PythonVoiceSession } from './voice/session.js'
import { inspectWorkspaceMcp, isWorkspaceMcpTrusted } from './workspace/trust.js'
import { WorkspaceSandbox } from './workspace/sandbox.js'
import type { SetupQuestionBroker } from './setup/questions.js'

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
  sessionCatalogPath?: string
  requestSetup?: RequestSetup
  configuration?: { config: CliConfigStore; draft: SetupConfiguration }
  setupQuestions?: SetupQuestionBroker
  conversation?: ChatConversation
}

interface ControllerRequest {
  workspace: string
  sessionDirectory: string
  sessionId?: string
  sessionManager?: HarnessAgentOptions['sessionManager']
  seed?: ChatForkState
  restoreSeedMessages?: boolean
  settings?: Partial<ChatSettings>
  conversation?: ChatConversation
}

export async function createInteractiveChat(options: CreateInteractiveChatOptions = {}): Promise<ConversationManager> {
  const initialWorkspace = resolve(options.cwd ?? process.cwd())
  const configuredSessionSettings = sessionSettings(options.agentOptions?.session)
  const initialSessionDirectory = resolve(initialWorkspace, configuredSessionSettings.dir ?? DEFAULT_SESSION_DIR)
  const sessionCatalog = await loadSessionCatalog(options.sessionCatalogPath)

  const config = options.config ?? (await CliConfigStore.load(options.configPath))
  const configuredInterventions = await resolveInterventions(options.agentOptions?.interventions)
  const configuredSessionId = configuredSessionSettings.id
  const {
    interventions: _interventions,
    session: _session,
    sessionManager: explicitSessionManager,
    skills: configuredSkills,
    sandbox: configuredSandbox,
    mcpServers: configuredMcpServers,
    ...portableAgentOptions
  } = options.agentOptions ?? {}
  // A `SessionManager` instance on `session` is honored like the SDK's `sessionManager`.
  const configuredSessionManager = explicitSessionManager ?? configuredSessionSettings.manager
  // TODO(skills): `FileSkillsRuntime` only honors string paths; an `AgentSkills` instance falls back to default discovery.
  const configuredSkillSources: SkillPathsOption =
    configuredSkills instanceof AgentSkills ? undefined : configuredSkills
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
  const sourceSelection = options.conversation?.sourceSelection
  const selectedAgentOptions =
    sourceDefinition &&
    sourceSelection?.source === sourceDefinition.source &&
    sourceSelection.configured.model === sourceDefinition.configured.model &&
    sourceSelection.configured.thinking === sourceDefinition.configured.thinking
      ? {
          ...portableAgentOptions,
          model: sourceSelection.selected.model,
          effort: profileEffort(sourceSelection.selected.thinking),
        }
      : portableAgentOptions
  const agentMessaging = new AgentMessaging()
  const subagentToolsByAgent = new Map<Agent, Tool>()
  const stopObservingSubagents = new Map<Tool, () => void>()
  const agents = new Set<Agent>()
  const controllerContexts = new WeakMap<ChatController, { workspace: string; sessionDirectory: string }>()
  let nextPeerEndpoint = 1
  let nextBackgroundEndpoint = 1
  let disposed = false

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

  const buildAgent = async (
    controllerOptions: HarnessAgentOptions,
    configuredTools: NonNullable<HarnessAgentOptions['tools']>,
    peerEndpointId: string,
    backgroundActivity: BackgroundAgentActivityStore,
    overrides: Partial<HarnessAgentOptions>,
    waitForCompletion: boolean
  ): Promise<Agent> => {
    if (disposed) {
      throw new Error('Runtime is disposed.')
    }
    const agentOptions = { ...controllerOptions, ...overrides }
    requireBedrockRegion(agentOptions.model)
    const agent = await (options.buildAgent ?? createHarness)({
      ...agentOptions,
      tools: [...configuredTools],
      plugins: [
        ...(agentOptions.plugins ?? []),
        ...(options.requestSetup
          ? [
              new ContextInjector({
                name: 'strands:configuration-awareness',
                renderContent: async ({ agent }): Promise<string> =>
                  `Your current configured name is ${JSON.stringify((agent as Agent).name)}. When stating your own name, use this ` +
                  `name instead of names in earlier conversation or memory.\n\n${CONFIGURATION_INSTRUCTIONS}`,
              }),
            ]
          : []),
        ...(config.snapshot().settings.agentMessaging ? [agentMessaging.createPlugin(peerEndpointId)] : []),
      ],
      backgroundTasks: interactiveBackgroundTasks(agentOptions, waitForCompletion),
      printer: false,
    }).catch(rethrowWithProviderHint)
    await initializeAgentDefinition(agent)
    agent.messages = upgradeDesktopAgentProfileMessages(agent.messages)
    await persistSessionAgentDefinition(agentOptions)
    if (disposed) {
      agentMessaging.unbindAgent(agent)
      throw new Error('Runtime was disposed while building an agent.')
    }
    agents.add(agent)
    const subagentTool = agent.toolRegistry.get('subagent')
    if (subagentTool) {
      subagentToolsByAgent.set(agent, subagentTool)
      if (!stopObservingSubagents.has(subagentTool)) {
        stopObservingSubagents.set(subagentTool, observeSubagentActivity(subagentTool, backgroundActivity))
      }
    }
    return agent
  }

  const disposeShared = async (): Promise<void> => {
    if (disposed) {
      return
    }
    disposed = true
    options.setupQuestions?.dispose()
    // Extraction runs in the background on a turn interval; flush every live agent at teardown so a
    // session that ends between intervals still persists its recent turns.
    await Promise.allSettled([...agents].map((agent) => agent.memoryManager?.flush()))
    for (const stop of stopObservingSubagents.values()) {
      stop()
    }
    stopObservingSubagents.clear()
    agents.clear()
    subagentToolsByAgent.clear()
  }

  const createController = async (request: ControllerRequest): Promise<ChatController> => {
    const peerEndpointId = `agent-${nextPeerEndpoint++}`
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
        name: summary ? `${endpoint.name}: ${summary.slice(0, 80)}` : endpoint.name,
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
    await registerSessionRoot(sessionCatalog, sessionDirectory, workspace)

    const baseAgentOptions: HarnessAgentOptions = sessionEnabled
      ? withSession(selectedAgentOptions, { id: sessionId, dir: sessionDirectory })
      : { ...selectedAgentOptions, session: false }
    const restoredAgentOptions = options.project
      ? baseAgentOptions
      : await restoreSessionAgentDefinition(baseAgentOptions, workspace)
    const skillPaths = resolveSkillPaths(configuredSkillSources, workspace, config.snapshot().settings.skillDiscovery)
    const profileSkillPaths = configuredSkillPaths(configuredSkillSources, workspace)
    const sandbox =
      configuredSandbox === undefined || configuredSandbox === false
        ? new WorkspaceSandbox(workspace)
        : configuredSandbox
    const mcp = await loadMcp({
      ...(await workspaceMcpOptions(options, initialWorkspace, workspace, config.snapshot().settings.mcpDiscovery)),
      ...(configuredMcpServers ? { servers: configuredMcpServers } : {}),
    })
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
      ...(options.setupQuestions ? { trustedTools: ['setup_question', 'strands_config'] } : {}),
    })
    const liveSteering: LiveSteering = new LiveSteering((candidate) => {
      return backgroundInbox.observeAgent((prompt): boolean => liveSteering.enqueue(candidate, prompt))
    })
    const controllerOptions: HarnessAgentOptions = {
      ...withSession(restoredAgentOptions, { id: sessionId, dir: sessionDirectory }),
      ...(request.seed ? { model: request.seed.model, effort: profileEffort(request.seed.thinking) } : {}),
      ...(request.sessionManager !== undefined ? { sessionManager: request.sessionManager } : {}),
      skills: skillPaths.length > 0 ? skillPaths : false,
      sandbox,
      interventions: [liveSteering, cedarPermissions, ...configuredInterventions],
    }

    const configSnapshot = config.snapshot()
    let exportProfile = {
      ...(options.agentProfile ?? configSnapshot.profile),
      ...(typeof controllerOptions.model === 'string' ? { model: controllerOptions.model, modelModule: null } : {}),
      effort: controllerOptions.effort ?? 'auto',
    }
    let agent: Agent | undefined
    const configuration = options.requestSetup
      ? createConfigurationTool({
          config: options.configuration?.config ?? config,
          profile: (): HarnessAgentConfig => exportProfile,
          agent: (): Agent | undefined => agent,
          ...(options.configuration ? { draft: options.configuration.draft } : {}),
          ...(options.project ? { source: options.project.entrypoint } : {}),
        })
      : undefined
    if (configuration) configuredTools.push(configuration.tool)
    let stopConfigurationWatch: (() => void) | undefined
    try {
      agent = await buildAgent(
        controllerOptions,
        configuredTools,
        peerEndpointId,
        backgroundActivity,
        {},
        request.seed?.backgroundTasksWaitForCompletion ?? false
      )
      if (request.seed && request.restoreSeedMessages !== false) {
        agent.messages = [...request.seed.messages]
        await agent.sessionManager?.saveSnapshot({
          target: agent,
          isLatest: true,
        })
      }
      if (request.conversation) {
        agent.loadSnapshot(request.conversation.snapshot)
        agent.messages = cloneConversation(agent.messages, request.conversation.model === agent.model.modelId)
        await agent.sessionManager?.saveSnapshot({ target: agent, isLatest: true })
      }

      const runtime = new AgentModelRuntime(agent, {
        ...(typeof controllerOptions.model === 'string' ? { initialModel: controllerOptions.model } : {}),
        providers: configSnapshot.providers.enabled,
        providerEnvironment: config.providerEnvironment(),
        discoverProviderModels,
        discoverContextWindow,
        thinking: controllerOptions.effort,
        ...(sessionId ? { sessionId } : {}),
        sessionDir: sessionDirectory,
        ...(controllerOptions.backgroundTasks === false
          ? {}
          : { backgroundTasksWaitForCompletion: request.seed?.backgroundTasksWaitForCompletion ?? false }),
        newSessionId: createInteractiveSessionId,
        onModelChange: async (change): Promise<void> => {
          exportProfile = {
            ...exportProfile,
            model: change.model,
            effort: change.effort,
            modelModule: change.model === exportProfile.model ? exportProfile.modelModule : null,
          }
          if (options.persistModelChanges !== false) {
            await config.setProfileModel(change.model, change.effort)
          }
        },
        restartAgent: async (restartRequest, previousAgent): Promise<Agent> => {
          const snapshot = restartRequest.preserveSnapshot
            ? previousAgent.takeSnapshot({ preset: 'session' })
            : undefined
          let nextAgent: Agent | undefined
          try {
            const overrides: Partial<HarnessAgentOptions> = {
              model: restartRequest.model,
              effort: profileEffort(restartRequest.thinking),
              ...(restartRequest.sessionId !== undefined || restartRequest.sessionDir
                ? {
                    session: withSession(controllerOptions, {
                      ...(restartRequest.sessionId !== undefined ? { id: restartRequest.sessionId ?? undefined } : {}),
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
              restartRequest.backgroundTasksWaitForCompletion
            )
            if (snapshot) {
              nextAgent.loadSnapshot(snapshot)
            } else if (restartRequest.preserveConversation) {
              nextAgent.messages = cloneConversation(previousAgent.messages, restartRequest.preserveReasoning !== false)
            }
          } catch (error) {
            if (nextAgent) {
              releaseAgent(nextAgent)
            }
            throw error
          }
          releaseAgent(previousAgent)
          agent = nextAgent
          return nextAgent
        },
      })

      const backend = new StrandsChatBackend(runtime, {
        ...(sourceDefinition ? { sourceDefinition } : {}),
        contextWindow: (): Promise<number | undefined> => runtime.contextWindow(),
        taskActivity: backgroundActivity,
        permissions: { broker: permissionBroker, policy: cedarPermissions },
        steering: liveSteering,
        contextScope: workspace,
        dispose: (): void => {
          stopConfigurationWatch?.()
          agentMessaging.unregister(peerEndpointId)
          backgroundInbox.dispose()
        },
      })
      const sessions = new FileSessionRuntime(runtime, sessionDirectory, {
        ...(sessionCatalog ? { catalog: sessionCatalog } : {}),
        workspace,
      })
      const skills = new FileSkillsRuntime(skillPaths, () => runtime.agent)
      const skillNames = (await skills.list()).map((skill) => skill.name)
      const controller = new ChatController(backend, {
        runtime: {
          version: HARNESS_VERSION,
          session: sessionId ?? (request.sessionManager !== undefined ? 'managed' : 'in-memory'),
          cwd: workspace,
        },
        settings: { ...configSnapshot.settings, ...request.settings },
        sessions,
        skills,
        skillNames,
        mcp,
        streamPresentation: DEFAULT_STREAM_PRESENTATION,
        initialMessages: agent.messages,
        ...(request.conversation ? { initialTurns: request.conversation.completedTurns } : {}),
        pinnedModels: configSnapshot.models.pinned,
        setModelPinned: (modelId, pinned): Promise<void> => config.setModelPinned(modelId, pinned),
        setSettings: (settings): Promise<void> => config.setSettings(settings),
        ...(options.project ? { project: options.project } : {}),
        exportAgentProject: (language, destination): Promise<string | undefined> =>
          options.project
            ? exportSourceProject(
                options.project,
                runtime.agent.name,
                language,
                [sessionDirectory, memoryDirectory(controllerOptions.memory)],
                destination
              )
            : exportAgentProject(
                options.configuration ? configuration!.profile() : exportProfile,
                language,
                profileSkillPaths,
                configSnapshot.profileBaseDir ?? initialWorkspace,
                destination
              ),
        ...(options.requestSetup ? { requestSetup: options.requestSetup } : {}),
        ...(options.setupQuestions ? { setupQuestions: options.setupQuestions } : {}),
        peerEndpointId,
      })
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
      return controller
    } catch (error) {
      permissionBroker.dispose()
      if (agent) {
        releaseAgent(agent)
      }
      backgroundInbox.dispose()
      await mcp.dispose()
      throw error
    }
  }

  try {
    const primary = await createController({
      workspace: initialWorkspace,
      sessionDirectory: initialSessionDirectory,
      ...(configuredSessionId ? { sessionId: configuredSessionId } : {}),
      ...(configuredSessionManager !== undefined ? { sessionManager: configuredSessionManager } : {}),
      ...(options.conversation ? { conversation: options.conversation } : {}),
    })
    return new ConversationManager(primary, {
      fork: async (source): Promise<ChatController> => {
        const seed = source.backend.forkState?.()
        const context = controllerContexts.get(source)
        if (!seed || !context) {
          throw new Error('Only Strands-backed conversations can be forked.')
        }
        return createController({
          workspace: context.workspace,
          sessionDirectory: context.sessionDirectory,
          seed,
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
      dispose: disposeShared,
      agentMessaging,
      voice: new PythonVoiceSession({ cwd: initialWorkspace }),
    })
  } catch (error) {
    await disposeShared()
    throw error
  }
}

function cloneConversation(messages: readonly Message[], preserveReasoning: boolean): Message[] {
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
  options: HarnessAgentOptions,
  waitForCompletion = false
): Exclude<HarnessAgentOptions['backgroundTasks'], undefined> {
  const configured = options.backgroundTasks
  if (configured === false) {
    return false
  }
  return { ...(configured === true ? {} : configured), waitForCompletion }
}

async function loadSessionCatalog(path: string | undefined): Promise<SessionRootCatalog | undefined> {
  try {
    return await SessionRootCatalog.load(path)
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
  options: CreateInteractiveChatOptions,
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
