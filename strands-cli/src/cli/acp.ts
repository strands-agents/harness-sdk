import * as acp from '@agentclientprotocol/sdk'
import { createHarness, type HarnessAgentOptions } from '@strands-agents/harness'
import { McpClient, type Agent, type McpServerConfig, type Usage } from '@strands-agents/sdk'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

import { projectAgentEvent, projectAgentResult } from '../agent/events.js'
import { loadMcp } from '../agent/mcp.js'
import { requireBedrockRegion } from '../model/aws-config.js'
import { HARNESS_VERSION, readCliVersion } from '../package-version.js'
import {
  AGENT_DEFINITION_META_KEY,
  persistSessionAgentDefinition,
  restoreSessionAgentDefinition,
  sessionAgentDefinitionFromMeta,
} from '../session/agent-definition.js'
import { upgradeDesktopAgentProfileMessages } from '../session/desktop-profile.js'
import { DEFAULT_SESSION_DIR, hasSavedSession, sessionDir, sessionSettings, withSession } from '../session/sessions.js'
import { latestRootModelUsage, RunUsage } from '../usage.js'
import { projectPrompt, replaySessionHistory, sendChatEvent, toAcpStopReason, toAcpUsage } from './acp-events.js'

const SESSION_SHUTDOWN_TIMEOUT_MS = 1_000

type AgentBuilder = (options: HarnessAgentOptions) => Promise<Agent>

interface AcpSession {
  agent: Agent
  mcpClients: readonly McpClient[]
  activePrompt?: Promise<void>
}

export class AcpService {
  private readonly _agentOptions: HarnessAgentOptions
  private readonly _buildAgent: AgentBuilder
  private readonly _sharedMcpClients: readonly McpClient[]
  private readonly _sourceAgent: boolean
  private readonly _sessions = new Map<string, AcpSession>()
  private readonly _openingSessions = new Set<string>()

  private _workspace: string | undefined
  private _disposed = false

  constructor(
    agentOptions: HarnessAgentOptions = {},
    options: {
      buildAgent?: AgentBuilder
      sharedMcpClients?: readonly McpClient[]
      sourceAgent?: boolean
    } = {}
  ) {
    this._agentOptions = { ...agentOptions, printer: false }
    this._buildAgent = options.buildAgent ?? createHarness
    this._sharedMcpClients = options.sharedMcpClients ?? []
    this._sourceAgent = options.sourceAgent ?? false
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion: params.protocolVersion <= acp.PROTOCOL_VERSION ? params.protocolVersion : acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: this._supportsSessionLoading,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      agentInfo: {
        name: '@strands-agents/cli',
        title: 'Strands harness',
        version: readCliVersion(),
      },
      _meta: {
        [AGENT_DEFINITION_META_KEY]: true,
      },
    }
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this._setWorkspace(params.cwd)
    const sessionId = randomUUID()
    await this._openSession(sessionId, params.mcpServers, sessionAgentDefinitionFromMeta(params._meta))
    return { sessionId }
  }

  async loadSession(params: acp.LoadSessionRequest, client: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    if (!this._supportsSessionLoading) {
      throw acp.RequestError.invalidParams(
        { sessionId: params.sessionId },
        'This agent does not support loading CLI-managed file sessions.'
      )
    }
    this._setWorkspace(params.cwd)
    const sessionId = validateSessionId(params.sessionId)
    const sessionDirectory = resolve(sessionDir(this._agentOptions) ?? DEFAULT_SESSION_DIR)
    if (!(await hasSavedSession(sessionDirectory, sessionId))) {
      throw acp.RequestError.resourceNotFound(sessionId)
    }
    const session = await this._openSession(
      sessionId,
      params.mcpServers,
      sessionAgentDefinitionFromMeta(params._meta),
      true
    )
    try {
      await replaySessionHistory(session.agent, sessionId, client)
    } catch (error) {
      this._sessions.delete(sessionId)
      await disposeSession(session)
      throw error
    }
    return {}
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this._sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Unknown session ${params.sessionId}.`)
    }
    if (session.activePrompt) {
      throw new Error(`Session ${params.sessionId} is already processing a prompt.`)
    }
    const stream = session.agent.stream(projectPrompt(params.prompt))
    let settlePrompt: () => void
    session.activePrompt = new Promise<void>((resolve) => {
      settlePrompt = resolve
    })
    try {
      const runUsage = RunUsage.start(session.agent)
      let latestModelUsage: Usage | undefined
      let next = await stream.next()
      while (!next.done) {
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
    } catch (error) {
      const iterator: AsyncIterator<unknown, unknown> = stream
      await iterator.return?.().catch(() => undefined)
      throw error
    } finally {
      settlePrompt!()
      delete session.activePrompt
    }
  }

  cancel(sessionId: string): void {
    this._sessions.get(sessionId)?.agent.cancel()
  }

  async dispose(): Promise<void> {
    this._disposed = true
    await Promise.allSettled([...this._sessions.values()].map(disposeSession))
    this._sessions.clear()
  }

  private async _openSession(
    sessionId: string,
    mcpServers: readonly acp.McpServer[],
    sessionAgentDefinition?: Pick<HarnessAgentOptions, 'name' | 'description' | 'instructions'>,
    resume = false
  ): Promise<AcpSession> {
    this._assertOpen()
    if (this._sessions.has(sessionId) || this._openingSessions.has(sessionId)) {
      throw acp.RequestError.invalidParams({ sessionId }, `Session ${sessionId} is already loaded.`)
    }
    this._openingSessions.add(sessionId)
    let mcpClients: McpClient[] = []
    let agent: Agent | undefined
    try {
      mcpClients = await loadAcpMcpClients(mcpServers)
      this._assertOpen()
      const baseOptions = withSession(this._agentOptions, { id: sessionId })
      const restoredAgentOptions = this._sourceAgent ? baseOptions : await restoreSessionAgentDefinition(baseOptions)
      const agentOptions = {
        ...restoredAgentOptions,
        ...sessionAgentDefinition,
        tools: [...(this._agentOptions.tools ?? []), ...this._sharedMcpClients, ...mcpClients],
        printer: false,
      }
      requireBedrockRegion(agentOptions.model)
      agent = await this._buildAgent(agentOptions)
      this._assertOpen()
      if (resume && agent.sessionManager?.sessionId !== sessionId) {
        throw acp.RequestError.resourceNotFound(sessionId)
      }
      await agent.initialize()
      agent.messages = upgradeDesktopAgentProfileMessages(agent.messages)
      await persistSessionAgentDefinition(agentOptions)
      this._assertOpen()
      const session = { agent, mcpClients }
      this._sessions.set(sessionId, session)
      return session
    } catch (error) {
      if (agent) {
        await disposeSession({ agent, mcpClients })
      } else {
        await disconnectMcpClients(mcpClients)
      }
      throw error
    } finally {
      this._openingSessions.delete(sessionId)
    }
  }

  private _assertOpen(): void {
    if (this._disposed) throw new Error('ACP service is closed.')
  }

  private get _supportsSessionLoading(): boolean {
    const session = sessionSettings(this._agentOptions.session)
    return session.enabled && session.manager === undefined && this._agentOptions.sessionManager === undefined
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
    .onRequest(acp.methods.agent.session.new, (context) => service.newSession(context.params))
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
  const definitions: Record<string, McpServerConfig> = Object.create(null)
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

async function disposeSession(session: AcpSession): Promise<void> {
  session.agent.cancel()
  await settleWithin(Promise.resolve(session.activePrompt).then(() => session.agent.shutdown())).catch(() => undefined)
  await disconnectMcpClients(session.mcpClients)
}

async function settleWithin(promise: Promise<void>): Promise<void> {
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
