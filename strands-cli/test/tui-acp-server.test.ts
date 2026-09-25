import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { createElement } from 'react'
import * as acp from '@agentclientprotocol/sdk'
import { createHarness, type HarnessAgentOptions } from '@strands-agents/harness'
import {
  Message,
  Model,
  TextBlock,
  type Agent,
  type AgentResult,
  type AgentStreamEvent,
  type ContentBlockData,
  type ModelStreamEvent,
} from '@strands-agents/sdk'
import { renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'

import { projectMessages } from '../src/tui/chat/projector.js'
import { DEFAULT_CHAT_SETTINGS, type ChatSnapshot } from '../src/tui/chat/controller.js'
import { createAcpApp, AcpService } from '../src/tui/acp/server.js'
import { restoreSessionAgentDefinition, AGENT_DEFINITION_META_KEY } from '../src/tui/session/agent-definition.js'
import { ChatView } from '../src/tui/view/chat-view.js'

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent
}

describe('ACP server', () => {
  it('constructs an agent per session and streams messages, reasoning, tools, usage, and media over ACP', async () => {
    let received: ContentBlockData[] | undefined
    const cancel = vi.fn()
    const initialize = vi.fn(async () => undefined)
    const fakeAgent = {
      addHook: vi.fn(),
      cancel,
      initialize,
      messages: [],
      model: { getConfig: () => ({ contextWindowLimit: 1_000 }) },
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
      expect(initialized.agentCapabilities).toMatchObject({
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
      })

      const session = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      })
      const response = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [
          { type: 'text', text: 'inspect' },
          { type: 'image', mimeType: 'image/png', data: 'AQID' },
        ],
      })

      expect(buildAgent).toHaveBeenCalledOnce()
      expect(buildAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ id: session.sessionId }),
          printer: false,
        })
      )
      expect(initialize).toHaveBeenCalledOnce()
      expect(received).toEqual([
        { text: 'inspect' },
        { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
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

  it('omits an ACP usage split when the pinned Gemini adapter cannot provide exact buckets', async () => {
    class GoogleModel {
      getConfig(): { contextWindowLimit: number } {
        return { contextWindowLimit: 1_000_000 }
      }
    }
    const usage = { inputTokens: 100, outputTokens: 55, totalTokens: 155 }
    const fakeAgent = {
      addHook: vi.fn(),
      cancel: vi.fn(),
      initialize: vi.fn(async () => undefined),
      messages: [],
      model: new GoogleModel(),
      async *stream() {
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelMetadataEvent', usage },
        } as unknown as AgentStreamEvent
        return {
          stopReason: 'endTurn',
          contextSize: 100,
          projectedContextSize: 155,
          metrics: { latestAgentInvocation: { usage } },
        } as AgentResult
      },
    } as unknown as Agent
    const service = new AcpService({}, { buildAgent: vi.fn(async () => fakeAgent) })
    const notify = vi.fn(
      async (_method: typeof acp.methods.client.session.update, _params: acp.SessionNotification) => undefined
    )
    const client = { notify } as unknown as acp.AgentContext

    try {
      const session = await service.newSession({ cwd: process.cwd(), mcpServers: [] })
      const response = await service.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        },
        client
      )

      expect(response).toEqual({ stopReason: 'end_turn' })
      expect(notify.mock.calls.map((call) => call[1].update)).toContainEqual({
        sessionUpdate: 'usage_update',
        used: 155,
        size: 1_000_000,
      })
    } finally {
      await service.dispose()
    }
  })

  it('loads a durable session and replays its restored history', async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), 'strands-acp-session-'))
    const sessionId = 'saved-session'
    await writeSavedSession(sessionDirectory, sessionId)
    const initialize = vi.fn(async () => undefined)
    const fakeAgent = {
      cancel: vi.fn(),
      initialize,
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

  it('persists an ACP prompt for direct CLI restore and a fresh ACP replay', async () => {
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
      const snapshot: ChatSnapshot = {
        completedTurns: projectMessages(cliAgent.messages, 'Strands harness'),
        queuedPrompts: [],
        notices: [],
        tasks: [],
        context: {},
        status: 'idle',
        runtime: {
          agent: 'Strands harness',
          version: 'test',
          backendId: 'strands',
          protocol: 'strands',
          model: 'persistence-test',
          session: sessionId,
          cwd: workspace,
          tools: [],
        },
        settings: DEFAULT_CHAT_SETTINGS,
      }
      const rendered = renderToString(
        createElement(ChatView, {
          snapshot,
          input: '',
          cursor: 0,
          terminalWidth: 100,
          terminalHeight: 30,
        })
      )
      expect(rendered).toContain('persist this request')
      expect(rendered).toContain('persisted reply')

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

  it('settles an active prompt before disposal completes', async () => {
    const streamStarted = deferred()
    const cancelled = deferred()
    const cancel = vi.fn(() => {
      cancelled.resolve()
    })
    const fakeAgentValue = {
      addHook: vi.fn(),
      cancel,
      initialize: vi.fn(async () => undefined),
      messages: [],
      model: { getConfig: () => ({}) },
      async *stream() {
        streamStarted.resolve()
        await cancelled.promise
        yield event({ type: 'beforeInvocationEvent' })
        return { stopReason: 'cancelled' } as AgentResult
      },
    }
    const fakeAgent = fakeAgentValue as unknown as Agent
    const service = new AcpService({}, { buildAgent: vi.fn(async () => fakeAgent) })
    const session = await service.newSession({ cwd: process.cwd(), mcpServers: [] })
    const client = { notify: vi.fn(async () => {}) } as unknown as acp.AgentContext
    const prompt = service.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'wait' }],
      },
      client
    )

    await streamStarted.promise
    await service.dispose()
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' })

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('keeps the process alive through bounded cleanup when a prompt ignores cancellation', async () => {
    const loader = fileURLToPath(new URL('./fixtures/strands-cli-routing-source-loader.mjs', import.meta.url))
    const fixture = fileURLToPath(new URL('./fixtures/acp-dispose-timeout-process.mjs', import.meta.url))
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', '--experimental-loader', loader, fixture],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] }
    )
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
