import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { createHarness, type HarnessAgentOptions } from '@strands-agents/harness'
import {
  Agent,
  FileStorage,
  McpClient,
  Message,
  Model,
  SessionManager,
  TextBlock,
  type AgentResult,
  type AgentStreamEvent,
  type ContentBlockData,
  type ModelStreamEvent,
} from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { createAcpApp, AcpService } from '../../src/cli/acp.js'
import { restoreSessionAgentDefinition, AGENT_DEFINITION_META_KEY } from '../../src/session/agent-definition.js'
import * as acpServer from '../../src/cli/acp.js'
import { CliConfigStore } from '../../src/config/store.js'
import { runPythonAcpServer } from '../../src/cli/acp-python.js'
import { PythonBackend } from '../../src/project/python.js'
import { startRemoteMcpServer } from '../fixtures/remote-mcp.js'

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent
}

describe('ACP server', () => {
  it('connects client MCP servers with literal object-property names', async () => {
    const remote = await startRemoteMcpServer('http', {}, { toolNames: ['probe'] })
    const service = new AcpService(
      { session: false },
      {
        buildAgent: async (options) => {
          const client = options.tools?.[0] as McpClient
          expect((await client.listTools()).map((tool) => tool.name)).toEqual(['__proto___probe'])
          return new Agent({ printer: false })
        },
      }
    )
    try {
      await service.newSession({
        cwd: process.cwd(),
        mcpServers: [{ name: '__proto__', type: 'http', url: remote.url, headers: [] }],
      })
      expect(remote.connections()).toBe(1)
    } finally {
      await service.dispose()
      await remote.close()
    }
  })

  it('requests an agent per session and streams messages, reasoning, tools, usage, and media over ACP', async () => {
    let received: ContentBlockData[] | undefined
    const documents = [
      ['text/markdown', 'md'],
      ['application/x-notes', 'txt'],
      ['constructor', 'txt'],
      ['__proto__', 'txt'],
    ] as const
    const cancel = vi.fn()
    const initialize = vi.fn(async () => undefined)
    const fakeAgent = {
      addHook: vi.fn(),
      cancel,
      shutdown: Agent.prototype.shutdown,
      initialize,
      messages: [],
      model: new BedrockModel({ contextWindowLimit: 1_000 }),
      async *stream(input: ContentBlockData[]) {
        received = input
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'thinking' },
          },
        } as unknown as AgentStreamEvent
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'answer' } },
        } as unknown as AgentStreamEvent
        yield {
          type: 'beforeToolCallEvent',
          toolUse: { toolUseId: 'tool-1', name: 'read', input: { path: 'README.md' } },
        } as unknown as AgentStreamEvent
        yield {
          type: 'toolResultEvent',
          result: {
            toolUseId: 'tool-1',
            status: 'success',
            content: [{ type: 'textBlock', text: 'contents' }],
          },
        } as unknown as AgentStreamEvent
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelMetadataEvent',
            usage: {
              inputTokens: 80,
              outputTokens: 20,
              totalTokens: 110,
              cacheReadInputTokens: 10,
            },
          },
        } as unknown as AgentStreamEvent
        return {
          stopReason: 'endTurn',
          contextSize: 80,
          projectedContextSize: 100,
          metrics: {
            latestAgentInvocation: {
              usage: {
                inputTokens: 80,
                outputTokens: 20,
                totalTokens: 110,
                cacheReadInputTokens: 10,
              },
            },
          },
        } as AgentResult
      },
    } as unknown as Agent
    const buildAgent = vi.fn(async () => fakeAgent)
    const service = new AcpService({}, { buildAgent })
    const updates: acp.SessionUpdate[] = []
    const client = acp.client({ name: 'test-client' }).onNotification(acp.methods.client.session.update, (context) => {
      updates.push(context.params.update)
    })
    const connection = client.connect(createAcpApp(service))

    try {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
      expect(initialized._meta?.[AGENT_DEFINITION_META_KEY]).toBe(true)
      expect(initialized.agentInfo?.version).toBe(
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
      )
      expect(initialized.agentCapabilities).toMatchObject({
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
      })

      const session = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      })
      const secondSession = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      })
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'inspect' },
          { type: 'image', mimeType: 'image/png', data: 'AQID' },
          ...documents.map(([mimeType]) => ({
            type: 'resource' as const,
            resource: { uri: 'file:///notes', mimeType, text: 'Document content' },
          })),
        ],
      })

      expect(buildAgent).toHaveBeenCalledTimes(2)
      expect(buildAgent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          session: expect.objectContaining({ id: session.sessionId }),
          printer: false,
        })
      )
      expect(buildAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          session: expect.objectContaining({ id: secondSession.sessionId }),
          printer: false,
        })
      )
      expect(initialize).toHaveBeenCalledTimes(2)
      expect(received).toEqual([
        { text: 'inspect' },
        { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
        ...documents.map(([, format]) => ({
          document: { name: 'notes', format, source: { text: 'Document content' } },
        })),
      ])
      expect(response).toMatchObject({
        stopReason: 'end_turn',
        usage: {
          inputTokens: 90,
          outputTokens: 20,
          totalTokens: 110,
          cachedReadTokens: 10,
        },
      })
      expect(updates).toMatchObject([
        { sessionUpdate: 'agent_thought_chunk', content: { text: 'thinking' } },
        { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } },
        { sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'read' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
        { sessionUpdate: 'usage_update', used: 110, size: 1_000 },
      ])

      service.cancel(session.sessionId)
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      connection.close()
      await connection.closed
      await service.dispose()
    }
  })

  it('upgrades and replays legacy Desktop profile messages when loading an ACP session', async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'strands-acp-session-'))
    const sessionId = 'saved-session'
    await writeSavedSession(sessionDirectory, sessionId)
    const initialize = vi.fn(async () => undefined)
    const fakeAgent = {
      cancel: vi.fn(),
      shutdown: Agent.prototype.shutdown,
      initialize,
      sessionManager: { sessionId },
      messages: [
        new Message({
          role: 'user',
          content: [
            new TextBlock(
              [
                '<strands_agent_profile>',
                'Name: John',
                'Job: Another tester',
                'Operating brief: Helpful agent who speaks like Tony Stark',
                'Keep this role for the entire durable session. Do not repeat this profile unless the user asks.',
                '</strands_agent_profile>',
                '',
                'Earlier request',
              ].join('\n')
            ),
          ],
        }),
      ],
    } as unknown as Agent
    const service = new AcpService({ session: { dir: sessionDirectory } }, { buildAgent: async () => fakeAgent })
    const notify = vi.fn(
      async (_method: typeof acp.methods.client.session.update, _params: acp.SessionNotification) => undefined
    )
    const client = { notify } as unknown as acp.AgentContext

    try {
      await service.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] }, client)
      expect(notify.mock.calls.map((call) => call[1].update)).toMatchObject([
        {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'text',
            text: expect.stringContaining(
              'The following fields describe you, the assistant. They do not describe the user.'
            ),
          },
        },
      ])
    } finally {
      await service.dispose()
      await rm(sessionDirectory, { recursive: true, force: true })
    }
  })

  it('persists and replays ACP prompts, and recovers when a client write fails', async () => {
    const modelInputs: string[][] = []

    class PersistenceModel extends Model {
      private config = { modelId: 'persistence-test', contextWindowLimit: 10_000 }

      updateConfig(config: { modelId?: string; contextWindowLimit?: number }): void {
        this.config = { ...this.config, ...config }
      }

      getConfig(): { modelId: string; contextWindowLimit: number } {
        return this.config
      }

      async *stream(messages: readonly Message[]): AsyncIterable<ModelStreamEvent> {
        modelInputs.push(
          messages.map((message) =>
            message.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('')
          )
        )
        yield { type: 'modelMessageStartEvent', role: 'assistant' }
        yield { type: 'modelContentBlockStartEvent' }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'persisted reply' },
        }
        yield { type: 'modelContentBlockStopEvent' }
        yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        yield {
          type: 'modelMetadataEvent',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          metrics: { latencyMs: 1 },
        }
      }
    }

    const originalCwd = process.cwd()
    const root = await mkdtemp(join(tmpdir(), 'strands-acp-persistence-'))
    const workspace = join(root, 'workspace')
    const sessionDirectory = join(workspace, '.agent', 'sessions')
    await mkdir(workspace, { recursive: true })
    const buildAgent = vi.fn((options: HarnessAgentOptions): Promise<Agent> =>
      createHarness({
        ...options,
        model: new PersistenceModel(),
        builtinTools: [],
        contextManager: false,
        printer: false,
      })
    )
    const client = {
      notify: vi.fn(async () => undefined),
    } as unknown as acp.AgentContext
    let first: AcpService | undefined

    try {
      first = new AcpService({ session: { dir: sessionDirectory } }, { buildAgent })
      const { sessionId } = await first.newSession({
        cwd: workspace,
        mcpServers: [],
        _meta: {
          [AGENT_DEFINITION_META_KEY]: {
            name: 'John',
            description: 'Another tester',
            instructions: 'Helpful agent who speaks like Tony Stark',
          },
        },
      })
      await first.prompt(
        {
          sessionId,
          prompt: [{ type: 'text', text: 'persist this request' }],
        },
        client
      )
      await first.dispose()
      first = undefined

      const restoredOptions = await restoreSessionAgentDefinition(
        { session: { id: sessionId, dir: sessionDirectory } },
        workspace
      )
      expect(restoredOptions).toMatchObject({
        name: 'John',
        description: 'Another tester',
        instructions: 'Helpful agent who speaks like Tony Stark',
      })
      const cliAgent = await buildAgent(restoredOptions)
      await cliAgent.initialize()
      expect(cliAgent.messages).toHaveLength(2)

      const replayed: string[] = []
      const second = new AcpService({ session: { dir: sessionDirectory } }, { buildAgent })
      await second.loadSession({ sessionId, cwd: workspace, mcpServers: [] }, {
        notify: vi.fn(async (_method, params: acp.SessionNotification) => {
          const update = params.update
          if (
            (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') &&
            update.content.type === 'text'
          ) {
            replayed.push(update.content.text)
          }
        }),
      } as unknown as acp.AgentContext)
      await second.dispose()

      expect(replayed).toEqual(['persist this request', 'persisted reply'])
      expect(buildAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          name: 'John',
          description: 'Another tester',
          instructions: 'Helpful agent who speaks like Tony Stark',
          session: expect.objectContaining({ id: sessionId }),
        })
      )

      const resumed = cliAgent.stream('what was the request?')
      for await (const _event of resumed) {
        // Drain the turn so the model receives the restored conversation.
      }
      expect(modelInputs.at(-1)).toEqual([
        'persist this request',
        'persisted reply',
        expect.stringContaining('what was the request?'),
      ])

      first = new AcpService({ session: false }, { buildAgent })
      const retrySession = await first.newSession({ cwd: workspace, mcpServers: [] })
      const request: acp.PromptRequest = {
        sessionId: retrySession.sessionId,
        prompt: [{ type: 'text', text: 'retry after a failed write' }],
      }
      const writeError = new Error('Client write failed')
      await expect(
        first.prompt(request, { notify: vi.fn().mockRejectedValue(writeError) } as unknown as acp.AgentContext)
      ).rejects.toBe(writeError)
      await expect(first.prompt(request, client)).resolves.toMatchObject({ stopReason: 'end_turn' })
    } finally {
      await first?.dispose()
      process.chdir(originalCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects missing and unsafe saved-session identifiers without constructing an agent', async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'strands-acp-session-'))
    const buildAgent = vi.fn()
    const service = new AcpService({ session: { dir: sessionDirectory } }, { buildAgent })
    const client = {
      notify: vi.fn(async () => undefined),
    } as unknown as acp.AgentContext

    try {
      await expect(
        service.loadSession(
          {
            sessionId: 'missing-session',
            cwd: process.cwd(),
            mcpServers: [],
          },
          client
        )
      ).rejects.toMatchObject({ code: -32002 })
      await expect(
        service.loadSession(
          {
            sessionId: '../outside',
            cwd: process.cwd(),
            mcpServers: [],
          },
          client
        )
      ).rejects.toMatchObject({ code: -32602 })
      expect(buildAgent).not.toHaveBeenCalled()
    } finally {
      await service.dispose()
      await rm(sessionDirectory, { recursive: true, force: true })
    }
  })

  it.each(['disabled', 'session manager', 'explicit manager'])(
    'does not advertise or construct a file-session resume for %s',
    async (kind) => {
      const manager = new SessionManager({ sessionId: 'other', storage: { snapshot: new FileStorage(tmpdir()) } })
      const options: HarnessAgentOptions =
        kind === 'disabled'
          ? { session: false }
          : kind === 'session manager'
            ? { session: manager }
            : { sessionManager: manager }
      const buildAgent = vi.fn()
      const service = new AcpService(options, { buildAgent })
      const notify = vi.fn()
      try {
        expect(
          service.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }).agentCapabilities
            ?.loadSession
        ).toBe(false)
        await expect(
          service.loadSession({ sessionId: 'saved-session', cwd: process.cwd(), mcpServers: [] }, {
            notify,
          } as unknown as acp.AgentContext)
        ).rejects.toMatchObject({ code: -32602 })
        expect(buildAgent).not.toHaveBeenCalled()
        expect(notify).not.toHaveBeenCalled()
      } finally {
        await service.dispose()
      }
    }
  )

  it.each(['disabled', 'different session'])('rejects a source factory with %s before replay', async (kind) => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'strands-acp-session-'))
    const sessionId = 'saved-session'
    await writeSavedSession(sessionDirectory, sessionId)
    const agent = new Agent({
      ...(kind === 'different session'
        ? {
            sessionManager: new SessionManager({
              sessionId: 'other',
              storage: { snapshot: new FileStorage(sessionDirectory) },
            }),
          }
        : {}),
      messages: [new Message({ role: 'user', content: [new TextBlock('Other conversation')] })],
      printer: false,
    })
    const initialize = vi.spyOn(agent, 'initialize')
    const service = new AcpService(
      { session: { dir: sessionDirectory } },
      { buildAgent: async () => agent, sourceAgent: true }
    )
    const notify = vi.fn()
    try {
      await expect(
        service.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] }, {
          notify,
        } as unknown as acp.AgentContext)
      ).rejects.toMatchObject({ code: -32002 })
      expect(initialize).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
      await expect(
        service.prompt({ sessionId, prompt: [] }, { notify } as unknown as acp.AgentContext)
      ).rejects.toThrow('Unknown session')
    } finally {
      await service.dispose()
      await rm(sessionDirectory, { recursive: true, force: true })
    }
  })

  it('reserves opening session IDs without blocking other sessions and releases failed reservations', async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'strands-acp-opening-'))
    const sessionId = 'saved-session'
    await writeSavedSession(sessionDirectory, sessionId)
    const started = deferred()
    const release = deferred()
    const initialize = vi.fn(async () => {})
    const buildAgent = vi.fn(async (options: HarnessAgentOptions) => {
      const id = (options.session as { id: string }).id
      if (id === sessionId && buildAgent.mock.calls.length === 1) {
        started.resolve()
        await release.promise
      }
      return {
        sessionManager: { sessionId: id },
        cancel: vi.fn(),
        shutdown: Agent.prototype.shutdown,
        initialize,
        messages: [],
      } as unknown as Agent
    })
    const service = new AcpService({ session: { dir: sessionDirectory } }, { buildAgent })
    const request = { sessionId, cwd: process.cwd(), mcpServers: [] }
    const client = { notify: vi.fn() } as unknown as acp.AgentContext
    const opening = service.loadSession(request, client)
    try {
      await started.promise
      await expect(service.loadSession(request, client)).rejects.toMatchObject({ code: -32602 })
      await expect(service.newSession({ cwd: process.cwd(), mcpServers: [] })).resolves.toHaveProperty('sessionId')
      expect(buildAgent).toHaveBeenCalledTimes(2)
      initialize.mockRejectedValueOnce(new Error('Initialization failed'))
      release.resolve()
      await expect(opening).rejects.toThrow('Initialization failed')
      await expect(service.loadSession(request, client)).resolves.toEqual({})
      expect(buildAgent).toHaveBeenCalledTimes(3)
    } finally {
      release.resolve()
      await opening.catch(() => {})
      await service.dispose()
      await rm(sessionDirectory, { recursive: true, force: true })
    }
  })

  it.each(['MCP connection', 'construction', 'initialization'])(
    'cleans sessions that finish %s after disposal',
    async (stage) => {
      const started = deferred()
      const release = deferred()
      const wait = async () => {
        started.resolve()
        await release.promise
      }
      const disconnect = vi.fn(async () => {})
      const loadServers = vi.spyOn(McpClient, 'loadServers').mockImplementation(async () => {
        if (stage === 'MCP connection') await wait()
        return [{ disconnect } as unknown as McpClient]
      })
      const cancel = vi.fn()
      const flush = vi.fn(async () => {})
      const initialize = vi.fn(async () => {
        if (stage === 'initialization') await wait()
      })
      const buildAgent = vi.fn(async () => {
        if (stage === 'construction') await wait()
        return {
          cancel,
          shutdown: Agent.prototype.shutdown,
          initialize,
          messages: [],
          memoryManager: { flush },
        } as unknown as Agent
      })
      const service = new AcpService({ session: false }, { buildAgent })
      const request = {
        cwd: process.cwd(),
        mcpServers: [{ name: 'fixture', command: 'unused', args: [], env: [] }],
      }
      const opening = service.newSession(request)
      try {
        await started.promise
        await service.dispose()
        release.resolve()
        await expect(opening).rejects.toThrow('ACP service is closed')
        expect(disconnect).toHaveBeenCalledOnce()
        if (stage === 'MCP connection') {
          expect(buildAgent).not.toHaveBeenCalled()
        } else {
          expect(cancel).toHaveBeenCalledOnce()
          expect(flush).toHaveBeenCalledOnce()
          expect(initialize).toHaveBeenCalledTimes(stage === 'initialization' ? 1 : 0)
        }
        await expect(service.newSession(request)).rejects.toThrow('ACP service is closed')
        expect(loadServers).toHaveBeenCalledOnce()
      } finally {
        release.resolve()
        await opening.catch(() => {})
        await service.dispose()
        loadServers.mockRestore()
      }
    }
  )

  it.each(['complete', 'reject', 'hang'])('flushes settled memory during bounded disposal (%s)', async (outcome) => {
    const streamStarted = deferred()
    const cancelled = deferred()
    let streamSettled = false
    const flushedWhileSettled: boolean[] = []
    const flush = vi.fn(async () => {
      flushedWhileSettled.push(streamSettled)
      if (outcome === 'reject') throw new Error('Memory unavailable')
      if (outcome === 'hang') await new Promise<void>(() => {})
    })
    const disconnect = vi.fn(async () => {})
    const loadServers = vi.spyOn(McpClient, 'loadServers').mockResolvedValue([{ disconnect } as unknown as McpClient])
    const cancel = vi.fn(() => {
      cancelled.resolve()
    })
    const fakeAgentValue = {
      addHook: vi.fn(),
      cancel,
      shutdown: Agent.prototype.shutdown,
      initialize: vi.fn(async () => undefined),
      messages: [],
      model: new BedrockModel({ modelId: 'test' }),
      memoryManager: { flush },
      async *stream() {
        streamStarted.resolve()
        await cancelled.promise
        yield event({ type: 'beforeInvocationEvent' })
        streamSettled = true
        return { stopReason: 'cancelled' } as AgentResult
      },
    }
    const fakeAgent = fakeAgentValue as unknown as Agent
    const service = new AcpService({}, { buildAgent: vi.fn(async () => fakeAgent) })
    const session = await service.newSession({
      cwd: process.cwd(),
      mcpServers: [{ name: 'fixture', command: 'unused', args: [], env: [] }],
    })
    const client = { notify: vi.fn(async () => {}) } as unknown as acp.AgentContext
    const prompt = service.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'wait' }],
      },
      client
    )

    try {
      await streamStarted.promise
      await service.dispose()
      await service.dispose()
      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })
      expect(cancel).toHaveBeenCalledOnce()
      expect(flush).toHaveBeenCalledOnce()
      expect(flushedWhileSettled).toEqual([true])
      expect(disconnect).toHaveBeenCalledOnce()
    } finally {
      loadServers.mockRestore()
      await service.dispose()
    }
  })

  it('keeps the process alive through bounded cleanup when a prompt ignores cancellation', async () => {
    const fixture = fileURLToPath(new URL('../fixtures/acp-dispose-timeout-process.mjs', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let output = ''
    let errorOutput = ''
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      errorOutput += chunk
    })

    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null]

    expect({ code, signal, errorOutput }).toMatchObject({ code: 0, signal: null, errorOutput: '' })
    expect(output).toContain('__DISPOSED__')
  }, 5_000)
})

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function writeSavedSession(sessionDirectory: string, sessionId: string): Promise<void> {
  const snapshots = join(sessionDirectory, sessionId, 'scopes', 'agent', 'agent', 'snapshots')
  await mkdir(snapshots, { recursive: true })
  await writeFile(join(snapshots, 'snapshot_latest.json'), '{"data":{"messages":[]}}')
}

describe('Python ACP session lifetime', () => {
  it.each(['duplicate', 'replay failure', 'connection closure'])('cleans up after %s', async (scenario) => {
    const closed = deferred()
    const release = deferred()
    let service!: Parameters<typeof createAcpApp>[0]
    let signal: AbortSignal | undefined
    const backends: { dispose: ReturnType<typeof vi.fn> }[] = []
    const app = vi.spyOn(acpServer, 'createAcpApp').mockImplementation((value) => {
      service = value
      return { connect: () => ({ closed: closed.promise }) } as unknown as acp.AgentApp
    })
    const open = vi.spyOn(PythonBackend, 'open').mockImplementation(async (_project, _config, _options, abort) => {
      signal = abort
      if (open.mock.calls.length === 1 && scenario !== 'replay failure') {
        await release.promise
        if (scenario === 'duplicate') throw new Error('Initialization failed')
      }
      const backend = {
        messages: [new Message({ role: 'user', content: [new TextBlock('Saved message')] })],
        dispose: vi.fn(async () => {}),
      }
      backends.push(backend)
      return backend as unknown as PythonBackend
    })
    const running = runPythonAcpServer(
      { root: process.cwd(), entrypoint: 'agent.py', language: 'python' },
      CliConfigStore.memory(),
      {}
    )
    const notify = vi.fn(async () => {})
    const client = { notify } as unknown as acp.AgentContext
    const request = { sessionId: 'saved-session', cwd: process.cwd(), mcpServers: [] }
    let pending: Promise<acp.LoadSessionResponse> | undefined
    try {
      if (scenario === 'replay failure') {
        notify.mockRejectedValueOnce(new Error('Replay failed'))
        await expect(service.loadSession(request, client)).rejects.toThrow('Replay failed')
        expect(backends[0]!.dispose).toHaveBeenCalledOnce()
        await expect(service.loadSession(request, client)).resolves.toEqual({})
      } else {
        pending = service.loadSession(request, client)
        const failed = pending.then(
          () => undefined,
          (error: unknown) => error
        )
        if (scenario === 'duplicate') {
          await expect(service.loadSession(request, client)).rejects.toMatchObject({ code: -32602 })
          expect(open).toHaveBeenCalledOnce()
          release.resolve()
          expect(await failed).toMatchObject({ message: 'Initialization failed' })
          await expect(service.loadSession(request, client)).resolves.toEqual({})
        } else {
          closed.resolve()
          await running
          expect(signal?.aborted).toBe(true)
          release.resolve()
          expect(await failed).toMatchObject({ message: 'ACP service is closed' })
          expect(backends[0]!.dispose).toHaveBeenCalledOnce()
          await expect(service.loadSession(request, client)).rejects.toThrow('ACP service is closed')
          expect(open).toHaveBeenCalledOnce()
        }
      }
    } finally {
      release.resolve()
      await pending?.catch(() => {})
      closed.resolve()
      await running
      open.mockRestore()
      app.mockRestore()
    }
    expect(backends.every((backend) => backend.dispose.mock.calls.length === 1)).toBe(true)
  })
})
