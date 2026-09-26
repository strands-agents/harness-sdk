import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { ImportedAgentProject } from './import.js'
import { createAcpApp, validateSessionId } from '../acp/server.js'
import { projectPrompt, replaySessionHistory, sendChatEvent, toAcpStopReason } from '../acp/projection.js'
import type { CliConfigStore } from '../config.js'
import { sessionAgentDefinitionFromMeta } from '../session/agent-definition.js'
import { PythonBackend, type PythonOptions } from './python.js'

export async function runPythonAcpServer(
  project: ImportedAgentProject,
  config: CliConfigStore,
  options: PythonOptions
): Promise<void> {
  const sessions = new Map<string, PythonBackend>()
  const open = async (
    sessionId: string,
    servers: acp.McpServer[],
    cwd: string,
    resume: boolean,
    meta?: Record<string, unknown> | null
  ): Promise<PythonBackend> => {
    if (sessions.has(sessionId)) {
      throw acp.RequestError.invalidParams({ sessionId }, 'This session is already loaded.')
    }
    if (servers.length > 0) {
      throw new Error('ACP MCP servers cannot be added to an authored source agent; declare them in its source.')
    }
    const backend = await PythonBackend.open(project, config, {
      ...options,
      overrides: { ...options.overrides, ...sessionAgentDefinitionFromMeta(meta) },
      sessionId,
      cwd,
      resume,
    })
    sessions.set(sessionId, backend)
    return backend
  }
  const app = createAcpApp({
    initialize: (params) => ({
      protocolVersion: Math.min(params.protocolVersion, acp.PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      agentInfo: { name: '@strands-agents/cli', title: 'Strands harness', version: '0.0.1' },
    }),
    newSession: async (params) => {
      const sessionId = randomUUID()
      await open(sessionId, params.mcpServers, params.cwd, false, params._meta)
      return { sessionId }
    },
    loadSession: async (params, client) => {
      const backend = await open(validateSessionId(params.sessionId), params.mcpServers, params.cwd, true, params._meta)
      await replaySessionHistory({ messages: backend.messages }, params.sessionId, client)
      return {}
    },
    prompt: async (params, client) => {
      const backend = sessions.get(params.sessionId)
      if (!backend) throw acp.RequestError.resourceNotFound(params.sessionId)
      const stream = backend.stream(projectPrompt(params.prompt))
      let next = await stream.next()
      try {
        while (!next.done) {
          if (next.value.type === 'permission') {
            const request = next.value.request
            const permission: acp.RequestPermissionRequest = {
              sessionId: params.sessionId,
              toolCall: { toolCallId: request.id, title: request.toolName, status: 'pending', rawInput: request.input },
              options: request.options.map((option) => ({
                optionId: option.id,
                name: option.label,
                kind: option.kind,
              })),
            }
            const result = await client.request(acp.methods.client.session.requestPermission, permission)
            backend.respondPermission(
              request.id,
              result.outcome.outcome === 'selected' ? result.outcome.optionId : 'deny'
            )
          } else {
            await sendChatEvent(client, params.sessionId, next.value)
          }
          next = await stream.next()
        }
        return { stopReason: toAcpStopReason(next.value.stopReason) }
      } finally {
        if (!next.done) await stream.return({ stopReason: 'cancelled' })
      }
    },
    cancel: (sessionId) => {
      sessions.get(sessionId)?.cancel()
    },
  })
  const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
  try {
    await connection.closed
  } finally {
    await Promise.allSettled([...sessions.values()].map((backend) => backend.dispose()))
  }
}
