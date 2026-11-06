import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createHarness, type HarnessAgentOptions } from '@strands-agents/harness'
import { McpClient, type Agent, type McpServerConfig, type Usage } from '@strands-agents/sdk'

import { hasReadyBackgroundResults, interactiveBackgroundTasks, readBackgroundTasks } from '../background/tasks.js'
import type { ChatTask } from '../chat/controller.js'
import { projectAgentEvent, projectAgentResult } from '../chat/sdk-projector.js'
import { upgradeDesktopAgentProfileMessages } from '../session/desktop-profile.js'
import {
  persistSessionAgentDefinition,
  restoreSessionAgentDefinition,
  sessionAgentDefinitionFromMeta,
  AGENT_DEFINITION_META_KEY,
} from '../session/agent-definition.js'
import { HARNESS_VERSION } from '../package-version.js'
import { sessionDir, withSession } from '../session/options.js'
import { DEFAULT_SESSION_DIR, hasSavedSession } from '../session/sessions.js'
import { projectPrompt, replaySessionHistory, sendChatEvent, toAcpStopReason, toAcpUsage } from './projection.js'
import { latestRootModelUsage, RunUsage } from '../../usage.js'
import { requireBedrockRegion } from '../provider/aws-config.js'
import { loadMcp } from '../mcp.js'

const SESSION_SHUTDOWN_TIMEOUT_MS = 1_000

/**
 * `_meta` key for background-task updates. `initialize` advertises `{ version: 1 }`. A session opts in
 * with `{ waitForCompletion: false }` on `session/new` or `session/load`: its turns then end while
 * background tasks run, each task change is sent as a `tool_call_update` for the call that started
 * it, and an empty `session/prompt` delivers finished results. See "ACP server" in README.md.
 */
export const BACKGROUND_TASKS_META_KEY = 'strands/backgroundTasks'
/** `_meta` key on a background-task `tool_call_update`: `{ taskId, status }`. */
export const BACKGROUND_TASK_META_KEY = 'strands/backgroundTask'
/** The interval at which an opted-in session's background tasks are read, as the terminal UI reads them. */
const BACKGROUND_TASK_POLL_MS = 200

type AgentBuilder = (options: HarnessAgentOptions) => Promise<Agent>

interface AcpSession {
  agent: Agent
  mcpClients: readonly McpClient[]
  activePrompt?: Promise<void>
  /** Set when the client opted in to background-task updates. See `BACKGROUND_TASKS_META_KEY`. */
  backgroundUpdates?: boolean
  /** Sends an update for each background task whose status changed. */
  publishBackgroundTasks?: () => Promise<void>
  stopBackgroundWatch?: () => void
  /** Counts cancels, so an empty prompt that waited for a turn can see one. */
  cancels?: number
}

export class AcpService {
  private readonly _agentOptions: HarnessAgentOptions
  private readonly _buildAgent: AgentBuilder
  private readonly _sharedMcpClients: readonly McpClient[]
  private readonly _sourceAgent: boolean
  private readonly _backgroundTaskPollMs: number
  private readonly _sessions = new Map<string, AcpSession>()

  private _workspace: string | undefined

  constructor(
    agentOptions: HarnessAgentOptions = {},
    options: {
      buildAgent?: AgentBuilder
      sharedMcpClients?: readonly McpClient[]
      sourceAgent?: boolean
      /** How often, in milliseconds, an opted-in session reads its background tasks. */
      backgroundTaskPollMs?: number
    } = {}
  ) {
    this._agentOptions = { ...agentOptions, printer: false }
    this._buildAgent = options.buildAgent ?? createHarness
    this._sharedMcpClients = options.sharedMcpClients ?? []
    this._sourceAgent = options.sourceAgent ?? false
    this._backgroundTaskPollMs = options.backgroundTaskPollMs ?? BACKGROUND_TASK_POLL_MS
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion: params.protocolVersion <= acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      agentInfo: {
        name: '@strands-agents/cli',
        title: 'Strands harness',
        version: '0.0.1',
      },
      _meta: {
        [AGENT_DEFINITION_META_KEY]: true,
        [BACKGROUND_TASKS_META_KEY]: { version: 1 },
      },
    }
  }

  async newSession(params: acp.NewSessionRequest, client?: acp.AgentContext): Promise<acp.NewSessionResponse> {
    this._setWorkspace(params.cwd)
    const sessionId = randomUUID()
    const backgroundUpdates = backgroundUpdatesRequested(params._meta)
    const session = await this._openSession(
      sessionId,
      params.mcpServers,
      sessionAgentDefinitionFromMeta(params._meta),
      backgroundUpdates
    )
    if (backgroundUpdates && client) {
      this._watchBackgroundTasks(sessionId, session, client)
    }
    return { sessionId }
  }

  async loadSession(params: acp.LoadSessionRequest, client: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    this._setWorkspace(params.cwd)
    const sessionId = validateSessionId(params.sessionId)
    const sessionDirectory = resolve(sessionDir(this._agentOptions) ?? DEFAULT_SESSION_DIR)
    if (!(await hasSavedSession(sessionDirectory, sessionId))) {
      throw acp.RequestError.resourceNotFound(sessionId)
    }
    const backgroundUpdates = backgroundUpdatesRequested(params._meta)
    const session = await this._openSession(
      sessionId,
      params.mcpServers,
      sessionAgentDefinitionFromMeta(params._meta),
      backgroundUpdates
    )
    try {
      await replaySessionHistory(session.agent, sessionId, client)
    } catch (error) {
      this._sessions.delete(sessionId)
      session.agent.cancel()
      await disconnectMcpClients(session.mcpClients)
      throw error
    }
    if (backgroundUpdates) {
      this._watchBackgroundTasks(sessionId, session, client)
    }
    return {}
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this._sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Unknown session ${params.sessionId}.`)
    }
    // An empty prompt asks for finished background results. A running turn hands those over by
    // itself, so the empty prompt waits for it, and the client learns when that turn ends.
    if (session.backgroundUpdates && params.prompt.length === 0) {
      const cancels = session.cancels ?? 0
      while (session.activePrompt) await session.activePrompt
      if ((session.cancels ?? 0) !== cancels) return { stopReason: 'cancelled' }
      if (!hasReadyBackgroundResults(session.agent)) return { stopReason: 'end_turn' }
    } else if (session.activePrompt) {
      throw new Error(`Session ${params.sessionId} is already processing a prompt.`)
    }
    let settlePrompt: () => void
    session.activePrompt = new Promise<void>((resolve) => {
      settlePrompt = resolve
    })
    try {
      const stream = session.agent.stream(projectPrompt(params.prompt))
      const runUsage = RunUsage.start(session.agent)
      let latestModelUsage: Usage | undefined
      let next = await stream.next()
      while (!next.done) {
        // The SDK hands finished tasks to the model at these two points and then drops them from
        // state, which can happen between two polls. Publishing here sends their final status first.
        if (next.value.type === 'beforeModelCallEvent' || next.value.type === 'afterInvocationEvent') {
          await session.publishBackgroundTasks?.()
        }
        latestModelUsage = latestRootModelUsage(session.agent, next.value) ?? latestModelUsage
        for (const event of projectAgentEvent(next.value)) {
          await sendChatEvent(client, params.sessionId, event)
        }
        next = await stream.next()
      }
      const result = projectAgentResult(session.agent, next.value, latestModelUsage, runUsage.total())
      const used = result.context?.projectedTokens ?? result.context?.currentTokens
      if (used !== undefined && result.context?.contextWindow !== undefined) {
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used,
            size: result.context.contextWindow,
          },
        })
      }
      const usage = result.usage ? toAcpUsage(result.usage) : undefined
      return {
        stopReason: toAcpStopReason(result.stopReason),
        ...(usage ? { usage } : {}),
      }
    } finally {
      settlePrompt!()
      delete session.activePrompt
    }
  }

  cancel(sessionId: string): void {
    const session = this._sessions.get(sessionId)
    if (!session) return
    session.cancels = (session.cancels ?? 0) + 1
    session.agent.cancel()
  }

  async dispose(): Promise<void> {
    const sessions = [...this._sessions.values()]
    for (const session of sessions) {
      session.stopBackgroundWatch?.()
      session.cancels = (session.cancels ?? 0) + 1
      session.agent.cancel()
    }
    await Promise.allSettled(sessions.map((session) => settleWithin(session.activePrompt)))
    await Promise.allSettled(sessions.map((session) => disconnectMcpClients(session.mcpClients)))
    this._sessions.clear()
  }

  private async _openSession(
    sessionId: string,
    mcpServers: readonly acp.McpServer[],
    sessionAgentDefinition?: Pick<HarnessAgentOptions, 'name' | 'description' | 'instructions'>,
    backgroundUpdates = false
  ): Promise<AcpSession> {
    if (this._sessions.has(sessionId)) {
      throw acp.RequestError.invalidParams({ sessionId }, `Session ${sessionId} is already loaded.`)
    }
    const mcpClients = await loadAcpMcpClients(mcpServers)
    try {
      const baseOptions = withSession(this._agentOptions, { id: sessionId })
      const restoredAgentOptions = this._sourceAgent ? baseOptions : await restoreSessionAgentDefinition(baseOptions)
      const agentOptions = {
        ...restoredAgentOptions,
        ...sessionAgentDefinition,
        tools: [...(this._agentOptions.tools ?? []), ...this._sharedMcpClients, ...mcpClients],
        printer: false,
        ...(backgroundUpdates ? { backgroundTasks: interactiveBackgroundTasks(restoredAgentOptions, false) } : {}),
      }
      requireBedrockRegion(agentOptions.model)
      const agent = await this._buildAgent(agentOptions)
      await agent.initialize()
      agent.messages = upgradeDesktopAgentProfileMessages(agent.messages)
      await persistSessionAgentDefinition(agentOptions)
      const session: AcpSession = { agent, mcpClients, ...(backgroundUpdates ? { backgroundUpdates } : {}) }
      this._sessions.set(sessionId, session)
      return session
    } catch (error) {
      await disconnectMcpClients(mcpClients)
      throw error
    }
  }

  /**
   * Sends a `tool_call_update` each time one of the session's background tasks changes status, for the
   * tool call that started it. Runs between turns too: a client learns there that results are ready.
   * Tasks present when the session opens are sent once, so a loaded session reports the stale tasks
   * that the SDK marked failed, whose results wait for delivery.
   */
  private _watchBackgroundTasks(sessionId: string, session: AcpSession, client: acp.AgentContext): void {
    const statuses = new Map<string, string>()
    session.publishBackgroundTasks = async (): Promise<void> => {
      const changed = readBackgroundTasks(session.agent).filter(
        (task) => task.toolUseId !== undefined && statuses.get(task.id) !== task.status
      )
      for (const task of changed) statuses.set(task.id, task.status)
      await Promise.all(
        changed.map((task) =>
          client
            .notify(acp.methods.client.session.update, {
              sessionId,
              update: backgroundTaskUpdate(task, task.toolUseId!),
            })
            .catch(() => {})
        )
      )
    }
    const timer = setInterval(() => void session.publishBackgroundTasks?.(), this._backgroundTaskPollMs)
    timer.unref()
    session.stopBackgroundWatch = (): void => clearInterval(timer)
  }

  private _setWorkspace(cwd: string): void {
    const workspace = resolve(cwd)
    if (this._workspace && this._workspace !== workspace) {
      throw new Error(
        `This ACP process is already serving ${this._workspace}; start a separate process for ${workspace}.`
      )
    }
    if (!this._workspace) {
      process.chdir(workspace)
      this._workspace = workspace
    }
  }
}

export function createAcpApp(
  service: Pick<AcpService, 'initialize' | 'newSession' | 'loadSession' | 'prompt' | 'cancel'>
): acp.AgentApp {
  return acp
    .agent({ name: 'strands' })
    .onRequest(acp.methods.agent.initialize, (context) => service.initialize(context.params))
    .onRequest(acp.methods.agent.session.new, (context) => service.newSession(context.params, context.client))
    .onRequest(acp.methods.agent.session.load, (context) => service.loadSession(context.params, context.client))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.prompt, (context) => service.prompt(context.params, context.client))
    .onNotification(acp.methods.agent.session.cancel, (context) => {
      service.cancel(context.params.sessionId)
    })
}

export async function runAcpServer(
  agentOptions: HarnessAgentOptions = {},
  options: {
    buildAgent?: AgentBuilder
    sourceAgent?: boolean
    mcpPaths?: readonly string[]
    mcpStrictPaths?: readonly string[]
    mcpDigests?: Readonly<Record<string, string>>
  } = {}
): Promise<void> {
  const sharedMcp = options.mcpPaths?.length
    ? await loadMcp({
        paths: options.mcpPaths,
        ...(options.mcpStrictPaths ? { strictPaths: options.mcpStrictPaths } : {}),
        ...(options.mcpDigests ? { expectedDigests: options.mcpDigests } : {}),
      })
    : undefined
  const service = new AcpService(agentOptions, {
    sharedMcpClients: sharedMcp?.clients ?? [],
    ...(options.buildAgent ? { buildAgent: options.buildAgent } : {}),
    ...(options.sourceAgent ? { sourceAgent: true } : {}),
  })
  try {
    const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
    const connection = createAcpApp(service).connect(stream)
    await connection.closed
  } finally {
    try {
      await service.dispose()
    } finally {
      await sharedMcp?.dispose()
    }
  }
}

async function loadAcpMcpClients(servers: readonly acp.McpServer[]): Promise<McpClient[]> {
  if (servers.length === 0) {
    return []
  }
  const definitions: Record<string, McpServerConfig> = {}
  for (const server of servers) {
    if ('command' in server) {
      definitions[server.name] = {
        command: server.command,
        args: [...server.args],
        env: Object.fromEntries(server.env.map((item) => [item.name, item.value])),
      }
    } else if (server.type === 'http' || server.type === 'sse') {
      definitions[server.name] = {
        url: server.url,
        transport: server.type === 'sse' ? 'sse' : 'streamable-http',
        headers: Object.fromEntries(server.headers.map((item) => [item.name, item.value])),
      }
    } else {
      throw new Error(`ACP-transport MCP servers are not supported: MCP server ${server.name}.`)
    }
  }
  return McpClient.loadServers(definitions, { applicationVersion: HARNESS_VERSION }, { prefixWithServerName: true })
}

async function disconnectMcpClients(clients: readonly McpClient[]): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.disconnect()))
}

async function settleWithin(promise: Promise<void> | undefined): Promise<void> {
  if (!promise) {
    return
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function validateSessionId(sessionId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,511}$/.test(sessionId)) {
    throw acp.RequestError.invalidParams(
      { sessionId },
      'Session IDs may contain lowercase letters, numbers, hyphens, and underscores.'
    )
  }
  return sessionId
}

/** Whether a `session/new` or `session/load` asked for background-task updates. See `BACKGROUND_TASKS_META_KEY`. */
function backgroundUpdatesRequested(meta: Record<string, unknown> | null | undefined): boolean {
  const requested = meta?.[BACKGROUND_TASKS_META_KEY]
  return (
    typeof requested === 'object' &&
    requested !== null &&
    (requested as { waitForCompletion?: unknown }).waitForCompletion === false
  )
}

/** A background task's state as an update of the tool call that started it. */
function backgroundTaskUpdate(task: ChatTask, toolCallId: string): acp.SessionUpdate {
  const terminal =
    task.status === 'completed'
      ? 'completed'
      : task.status === 'failed' || task.status === 'cancelled'
        ? 'failed'
        : undefined
  const text =
    task.status === 'completed' ? task.result : (task.error ?? (task.status === 'cancelled' ? 'Cancelled.' : undefined))
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: terminal ?? 'in_progress',
    ...(terminal && text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}),
    _meta: { [BACKGROUND_TASK_META_KEY]: { taskId: task.id, status: task.status } },
  }
}
