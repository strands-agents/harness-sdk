import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Agent, Message, TextBlock, type AgentResult, type AgentStreamEvent } from '@strands-agents/sdk'
import { resolveModel } from '@strands-agents/harness/internal'

import { BackgroundAgentActivityStore } from '../src/tui/background/activity.js'
import type { ChatEvent, ChatRunResult } from '../src/tui/chat/controller.js'
import {
  SHELL_OUTPUT_HARD_LIMIT_BYTES,
  SHELL_OUTPUT_HARD_LIMIT_LABEL,
  SHELL_OUTPUT_LIMIT_BYTES,
  SHELL_OUTPUT_LIMIT_NOTICE,
  SHELL_OUTPUT_PREVIEW_LABEL,
} from '../src/tui/terminal/shell-output.js'
import { StrandsChatBackend } from '../src/tui/strands-backend.js'
import { AgentModelRuntime } from '../src/tui/model/runtime.js'

function withSnapshotMethods<T extends object>(agent: T): T {
  return Object.assign(agent, {
    addHook: () => {},
    takeSnapshot: () => ({}),
    loadSnapshot: () => {},
  })
}

async function collectStream(
  stream: AsyncGenerator<ChatEvent, ChatRunResult, undefined>
): Promise<{ events: ChatEvent[]; result: ChatRunResult }> {
  const events: ChatEvent[] = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}

describe('StrandsChatBackend', () => {
  it('displays Auto for a model without effort controls even with thinking disabled', async () => {
    const modelId = 'ollama/qwen3:8b'
    const model = await resolveModel(modelId, modelId, 'off')
    const runtime = new AgentModelRuntime(new Agent({ model, printer: false }), {
      initialModel: modelId,
      thinking: null,
    })
    const backend = new StrandsChatBackend(runtime)

    expect(backend.listEfforts()).toEqual([])
    expect(backend.info().effort).toBe('Auto')
    expect(runtime.thinking).toBeNull()
  })

  it.each(['auto', null] as const)('displays the resolved Astra effort for %s', async (thinking) => {
    const modelId = 'bedrock/global.openai.gpt-6-astra'
    const model = await resolveModel(modelId, modelId, thinking ?? 'off')
    const agent = new Agent({ model, printer: false })
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent, { initialModel: modelId, thinking }))

    expect(backend.info().effort).toBe(thinking === 'auto' ? 'High' : 'Off')
  })

  it('uses the runtime contract for model controls, forks, and unsupported reconfiguration', async () => {
    const agent = new Agent({
      printer: false,
      messages: [new Message({ role: 'user', content: [new TextBlock('prior')] })],
    })
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent, { sessionId: 'session-1' }))

    expect(backend.info()).toMatchObject({ effort: 'High', sessionId: 'session-1' })
    expect(backend.listEfforts()).toContainEqual({ id: 'high', label: 'High', active: true })
    expect(backend.modelChangeMode('openai/other-model')).toBe('restart')
    await expect(backend.switchModel('openai/other-model')).rejects.toThrow('requires restarting')
    await expect(backend.restartModel('openai/other-model')).rejects.toThrow('cannot rebuild')
    await expect(backend.setEffort('unsupported')).rejects.toThrow('is not supported')
    await expect(backend.clear()).rejects.toThrow('cannot rebuild')
    await expect(backend.setBackgroundTasksWaitForCompletion(true)).rejects.toThrow('Background Tasks are disabled')
    expect(backend.backgroundTasksWaitForCompletion()).toBeUndefined()
    const fork = backend.forkState()
    expect(fork.messages).toEqual(agent.messages)
    expect(fork.messages[0]).not.toBe(agent.messages[0])
  })

  it('rejects permission changes when no permission policy is configured', async () => {
    const backend = new StrandsChatBackend(new AgentModelRuntime(new Agent({ printer: false })))

    expect(backend.permissionStatus()).toBeUndefined()
    expect(backend.respondPermission('request-1', 'allow')).toBe(false)
    await expect(backend.setPermissionMode('bypassPermissions')).rejects.toThrow('cannot configure permissions')
    await expect(backend.allowPermission('shell')).rejects.toThrow('cannot configure permissions')
    await expect(backend.removeAllowedPermission('shell')).rejects.toThrow('cannot configure permissions')
  })

  it('restores conversation history when a model invocation fails', async () => {
    const snapshot = { id: 'before-invocation' }
    let state = 'before invocation'
    const saveSnapshot = vi.fn(async () => {})
    const agent = {
      addHook: () => {},
      name: 'Strands harness',
      appState: { get: () => undefined },
      messages: [new Message({ role: 'user', content: [new TextBlock('prior prompt')] })],
      model: { modelId: 'model', getConfig: () => ({}) },
      tools: [],
      takeSnapshot: vi.fn(() => snapshot),
      loadSnapshot: vi.fn(() => {
        agent.messages = [new Message({ role: 'user', content: [new TextBlock('prior prompt')] })]
        state = 'before invocation'
      }),
      sessionManager: { saveSnapshot },
      cancel: () => {},
      async *stream() {
        yield* []
        agent.messages.push(new Message({ role: 'user', content: [new TextBlock('failed prompt')] }))
        state = 'partially updated'
        throw new Error('provider rejected request')
      },
    } as unknown as Agent
    const stream = new StrandsChatBackend(new AgentModelRuntime(agent)).stream('failed prompt')

    expect((await stream.next()).value).toEqual({ type: 'tasks', tasks: [] })
    await expect(stream.next()).rejects.toThrow('provider rejected request')

    expect(agent.messages).toHaveLength(1)
    expect(agent.messages[0]?.content).toEqual([{ type: 'textBlock', text: 'prior prompt' }])
    expect(state).toBe('before invocation')
    expect(agent.takeSnapshot).toHaveBeenCalledWith({ preset: 'session' })
    expect(agent.loadSnapshot).toHaveBeenCalledWith(snapshot)
    expect(saveSnapshot).toHaveBeenCalledWith({ target: agent, isLatest: true })
  })

  it('reports both the model and rollback failure when a failed turn cannot be persisted', async () => {
    const modelError = new Error('provider rejected request')
    const persistenceError = new Error('snapshot write failed')
    const agent = {
      addHook: () => {},
      name: 'Strands harness',
      appState: { get: () => undefined },
      messages: [],
      model: { modelId: 'model', getConfig: () => ({}) },
      tools: [],
      takeSnapshot: () => ({ id: 'before-invocation' }),
      loadSnapshot: () => {},
      sessionManager: { saveSnapshot: async () => Promise.reject(persistenceError) },
      cancel: () => {},
      async *stream() {
        yield* []
        throw modelError
      },
    } as unknown as Agent
    const stream = new StrandsChatBackend(new AgentModelRuntime(agent)).stream('failed prompt')

    expect((await stream.next()).value).toEqual({ type: 'tasks', tasks: [] })
    await expect(stream.next()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Model invocation failed, and the previous session state could not be fully restored.',
      errors: [modelError, persistenceError],
    })
  })

  it('persists peer attribution in the SDK message passed to the agent', async () => {
    const args: unknown[] = []
    const agent = withSnapshotMethods({
      name: 'Strands harness',
      appState: { get: () => undefined },
      messages: [],
      model: { modelId: 'model', getConfig: () => ({}) },
      tools: [],
      cancel: () => {},
      async *stream(input: unknown) {
        args.push(input)
        yield* []
        return { stopReason: 'endTurn' } as AgentResult
      },
    }) as unknown as Agent
    const message = {
      from: { id: 'agent-2', name: 'Reviewer' },
      body: 'Please inspect the parser.',
    }
    await collectStream(new StrandsChatBackend(new AgentModelRuntime(agent)).streamPeer(message))

    expect(args).toHaveLength(1)
    expect(args[0]).toMatchObject([
      {
        role: 'user',
        content: [
          {
            type: 'textBlock',
            text: expect.stringContaining('Please inspect the parser.'),
          },
        ],
        metadata: {
          custom: {
            'strands.peerMessage': message,
          },
        },
      },
    ])
  })

  it('streams bang commands through the active agent sandbox', async () => {
    const executeStreaming = vi.fn(async function* (
      command: string,
      options?: { timeout?: number; signal?: AbortSignal }
    ) {
      expect(command).toBe('printf output')
      expect(options?.timeout).toBe(120)
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      yield { type: 'streamChunk' as const, streamType: 'stdout' as const, data: 'out\n' }
      yield { type: 'streamChunk' as const, streamType: 'stderr' as const, data: 'warning\n' }
      yield {
        type: 'executionResult' as const,
        exitCode: 7,
        stdout: 'out\n',
        stderr: 'warning\n',
        outputFiles: [],
      }
    })
    const agent = {
      name: 'Strands harness',
      sandbox: { executeStreaming },
      cancel: () => {},
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))
    const { events, result: runResult } = await collectStream(backend.streamShell('printf output'))

    expect(executeStreaming).toHaveBeenCalledOnce()
    expect(events).toEqual([
      {
        type: 'toolStart',
        toolUseId: expect.stringMatching(/^shell-/),
        name: 'shell',
        input: { command: 'printf output' },
      },
      {
        type: 'toolOutputDelta',
        toolUseId: expect.stringMatching(/^shell-/),
        stream: 'stdout',
        text: 'out\n',
      },
      {
        type: 'toolOutputDelta',
        toolUseId: expect.stringMatching(/^shell-/),
        stream: 'stderr',
        text: 'warning\n',
      },
      {
        type: 'toolResult',
        toolUseId: expect.stringMatching(/^shell-/),
        status: 'error',
        content: [{ type: 'text', text: 'out\nwarning\n' }],
        error: 'Shell command exited with status 7.',
      },
    ])
    expect(runResult).toEqual({ stopReason: 'endTurn' })
  })

  it('cancels a running bang command through its sandbox abort signal', async () => {
    const executeStreaming = async function* (_command: string, options?: { signal?: AbortSignal }) {
      yield { type: 'streamChunk' as const, streamType: 'stdout' as const, data: 'started\n' }
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield {
        type: 'executionResult' as const,
        exitCode: 130,
        stdout: 'started\n',
        stderr: '',
        outputFiles: [],
      }
    }
    const agent = {
      name: 'Strands harness',
      sandbox: { executeStreaming },
      cancel: vi.fn(),
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))
    const stream = backend.streamShell('sleep 10')

    expect((await stream.next()).value).toMatchObject({ type: 'toolStart' })
    expect((await stream.next()).value).toMatchObject({ type: 'toolOutputDelta', text: 'started\n' })
    const completion = stream.next()
    backend.cancel()

    await expect(completion).resolves.toEqual({
      done: true,
      value: { stopReason: 'cancelled' },
    })
    expect(agent.cancel).toHaveBeenCalledOnce()
  })

  it('persists oversized bang output and lets the command finish', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-shell-output-'))
    const outputDirectory = join(directory, 'tool-results')
    const prefix = 'x'.repeat(SHELL_OUTPUT_LIMIT_BYTES)
    const warning = 'warning after spill\n'
    const completion = 'command completed\n'
    const fullOutput = `${prefix}${warning}${completion}`
    let signal: AbortSignal | undefined
    let commandCompleted = false
    const executeStreaming = async function* (_command: string, options?: { signal?: AbortSignal }) {
      signal = options?.signal
      yield { type: 'streamChunk' as const, streamType: 'stdout' as const, data: prefix }
      yield { type: 'streamChunk' as const, streamType: 'stderr' as const, data: warning }
      yield { type: 'streamChunk' as const, streamType: 'stdout' as const, data: completion }
      commandCompleted = true
      yield {
        type: 'executionResult' as const,
        exitCode: 0,
        stdout: `${prefix}${completion}`,
        stderr: warning,
        outputFiles: [],
      }
    }
    const agent = {
      name: 'Strands harness',
      sandbox: { executeStreaming },
      cancel: () => {},
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent), { shellOutputDirectory: outputDirectory })

    try {
      const { events, result: runResult } = await collectStream(backend.streamShell('generate lots of output'))

      expect(signal?.aborted).toBe(false)
      expect(commandCompleted).toBe(true)
      const files = await readdir(outputDirectory)
      expect(files).toHaveLength(1)
      const outputPath = join(outputDirectory, files[0]!)
      expect(await readFile(outputPath, 'utf8')).toBe(fullOutput)
      if (process.platform !== 'win32') {
        expect((await stat(outputDirectory)).mode & 0o777).toBe(0o700)
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600)
      }

      const streamed = events
        .filter((event) => event.type === 'toolOutputDelta')
        .map((event) => event.text)
        .join('')
      expect(streamed).toBe(`${prefix}${SHELL_OUTPUT_LIMIT_NOTICE}`)
      const result = events.at(-1)
      expect(result).toMatchObject({
        type: 'toolResult',
        status: 'success',
        content: [{ type: 'text', text: expect.stringContaining(`Full output saved to: ${outputPath}`) }],
      })
      if (result?.type === 'toolResult' && result.content[0]?.type === 'text') {
        expect(result.content[0].text).toContain(`Preview (first ${SHELL_OUTPUT_PREVIEW_LABEL}):\n${'x'.repeat(2048)}`)
        expect(result.content[0].text).not.toContain(completion)
        expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(4096)
      }
      expect(runResult).toEqual({ stopReason: 'endTurn' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops a bang command at the emergency output limit', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-shell-output-emergency-'))
    const outputDirectory = join(directory, 'tool-results')
    const oversized = 'z'.repeat(SHELL_OUTPUT_HARD_LIMIT_BYTES + 1)
    let signal: AbortSignal | undefined
    let iteratorClosed = false
    const executeStreaming = async function* (_command: string, options?: { signal?: AbortSignal }) {
      signal = options?.signal
      try {
        yield { type: 'streamChunk' as const, streamType: 'stdout' as const, data: oversized }
      } finally {
        iteratorClosed = true
      }
    }
    const agent = {
      name: 'Strands harness',
      sandbox: { executeStreaming },
      cancel: () => {},
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent), { shellOutputDirectory: outputDirectory })

    try {
      const { events, result: runResult } = await collectStream(backend.streamShell('yes'))

      expect(signal?.aborted).toBe(true)
      expect(iteratorClosed).toBe(true)
      const [file] = await readdir(outputDirectory)
      const outputPath = join(outputDirectory, file!)
      expect((await stat(outputPath)).size).toBe(SHELL_OUTPUT_HARD_LIMIT_BYTES)
      expect(events.at(-1)).toMatchObject({
        type: 'toolResult',
        status: 'error',
        content: [{ type: 'text', text: expect.stringContaining(`Partial output saved to: ${outputPath}`) }],
        error: `Shell command exceeded the ${SHELL_OUTPUT_HARD_LIMIT_LABEL} emergency output limit and was stopped.`,
      })
      expect(runResult).toEqual({ stopReason: 'endTurn' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('caps non-streaming bang output at the emergency output limit', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-shell-output-non-streaming-emergency-'))
    const outputDirectory = join(directory, 'tool-results')
    const oversized = 'z'.repeat(SHELL_OUTPUT_HARD_LIMIT_BYTES + 1)
    const executeStreaming = async function* () {
      yield {
        type: 'executionResult' as const,
        exitCode: 0,
        stdout: oversized,
        stderr: '',
        outputFiles: [],
      }
    }
    const agent = {
      name: 'Strands harness',
      sandbox: { executeStreaming },
      cancel: () => {},
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent), { shellOutputDirectory: outputDirectory })

    try {
      const { events, result: runResult } = await collectStream(backend.streamShell('generate one large result'))

      const [file] = await readdir(outputDirectory)
      const outputPath = join(outputDirectory, file!)
      expect((await stat(outputPath)).size).toBe(SHELL_OUTPUT_HARD_LIMIT_BYTES)
      expect(events.at(-1)).toMatchObject({
        type: 'toolResult',
        status: 'error',
        content: [{ type: 'text', text: expect.stringContaining(`Partial output saved to: ${outputPath}`) }],
        error: `Shell command exceeded the ${SHELL_OUTPUT_HARD_LIMIT_LABEL} emergency output limit and was stopped.`,
      })
      expect(runResult).toEqual({ stopReason: 'endTurn' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('correlates durable tasks with observed subagent activity by tool-use ID', () => {
    const activity = new BackgroundAgentActivityStore()
    activity.onStart({
      name: 'subagent',
      task: 'Review authentication.',
      toolUseId: 'subagent-1',
    })
    const agent = {
      cancel: () => {},
      appState: {
        get: () => [
          {
            taskId: 'task-1',
            toolUseId: 'subagent-1',
            toolName: 'subagent',
            status: 'working',
          },
        ],
      },
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent), { taskActivity: activity })
    const unwatch = backend.watchTasks(() => {})

    expect(backend.getTaskActivity('task-1')).toMatchObject({
      taskId: 'task-1',
      toolUseId: 'subagent-1',
      name: 'subagent',
      status: 'working',
    })

    unwatch()
    backend.dispose()
  })

  it('publishes durable task results after the model turn has returned', () => {
    vi.useFakeTimers()
    let state: unknown = {}
    const agent = {
      cancel: () => {},
      appState: { get: () => state },
    } as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))
    const updates: unknown[] = []
    const unwatch = backend.watchTasks((tasks) => updates.push(tasks))

    state = [
      {
        taskId: 'task-1',
        toolUseId: 'subagent-1',
        toolName: 'subagent',
        status: 'completed',
        lastUpdatedAt: '2026-08-05T18:00:00.000Z',
        result: {
          content: [{ type: 'textBlock', text: 'No issue found.' }],
        },
      },
      { status: 'working' },
    ]
    vi.advanceTimersByTime(200)

    expect(updates).toEqual([
      [],
      [
        {
          id: 'task-1',
          label: 'subagent',
          status: 'completed',
          source: 'background',
          detail: 'subagent | task-1',
          toolUseId: 'subagent-1',
          deliveryState: 'ready',
          result: 'No issue found.',
        },
      ],
    ])

    unwatch()
    backend.dispose()
    vi.useRealTimers()
  })

  it('continues a ready background result without adding a user prompt', async () => {
    const args: unknown[] = []
    const agent = withSnapshotMethods({
      name: 'Strands harness',
      appState: {
        get: () => [
          {
            taskId: 'task-1',
            toolUseId: 'subagent-1',
            toolName: 'subagent',
            status: 'completed',
          },
        ],
      },
      model: { getConfig: () => ({}) },
      async *stream(input: unknown) {
        args.push(input)
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Result received.' } },
        } as unknown as AgentStreamEvent
        return { stopReason: 'endTurn' } as AgentResult
      },
    }) as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))

    expect(backend.hasReadyBackgroundResults()).toBe(true)
    await collectStream(backend.streamBackgroundResults())

    expect(args).toEqual([[]])
  })

  it('streams todos from app state and reports exact usage and context', async () => {
    const appState = new Map<string, unknown>([
      [
        'todos',
        [
          { content: 'First', activeForm: 'Doing first', status: 'in_progress' },
          { content: 'Second', activeForm: 'Doing second', status: 'pending' },
        ],
      ],
    ])
    const agent = withSnapshotMethods({
      name: 'Strands Agent',
      appState,
      model: { getConfig: () => ({ contextWindowLimit: 1_000 }) },
      cancel: vi.fn(),
      async *stream() {
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } },
        } as unknown as AgentStreamEvent
        return {
          stopReason: 'endTurn',
          contextSize: 100,
          projectedContextSize: 125,
          metrics: {
            latestAgentInvocation: {
              usage: {
                inputTokens: 100,
                outputTokens: 25,
                totalTokens: 125,
                cacheReadInputTokens: 50,
                cacheWriteInputTokens: 10,
              },
            },
          },
        } as AgentResult
      },
    }) as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))
    const { events, result: runResult } = await collectStream(backend.stream('go'))

    expect(backend.name).toBe('Strands harness')
    expect(events).toMatchObject([
      {
        type: 'tasks',
        tasks: [
          { label: 'Doing first', source: 'todo' },
          { label: 'Second', source: 'todo' },
        ],
      },
      { type: 'textDelta', text: 'done' },
    ])
    expect(runResult).toEqual({
      stopReason: 'endTurn',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 10,
      },
      context: {
        currentTokens: 100,
        projectedTokens: 125,
        contextWindow: 1_000,
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 10,
      },
    })

    backend.cancel()
    expect(agent.cancel).toHaveBeenCalledOnce()
  })

  it.each([undefined, 800])('persists and restores compatible context with discovered limit %s', async (limit) => {
    const user = new Message({
      role: 'user',
      content: [new TextBlock('question')],
    })
    const messages = [user]
    const saveSnapshot = vi.fn(async () => {})
    let summaryContent = [new TextBlock('summary')]
    const model = {
      modelId: 'anthropic.claude-test',
      getConfig: () => ({ modelId: 'anthropic.claude-test', contextWindowLimit: 1_000 }),
      countTokens: vi.fn(async () => 42),
      async *streamAggregated() {
        yield* []
        return {
          message: {
            content: summaryContent,
          },
        }
      },
    }
    const assistant = new Message({
      role: 'assistant',
      content: [new TextBlock('done')],
      metadata: {
        usage: {
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
        },
      },
    })
    const agent = withSnapshotMethods({
      name: 'Strands harness',
      appState: { get: () => undefined },
      messages,
      model,
      tools: [],
      systemPrompt: 'system',
      sessionManager: { saveSnapshot },
      cancel: () => {},
      async *stream() {
        yield* []
        messages.push(assistant)
        return {
          stopReason: 'endTurn',
          lastMessage: assistant,
          metrics: {
            latestAgentInvocation: {
              usage: {
                inputTokens: 100,
                outputTokens: 25,
                totalTokens: 125,
              },
              cycles: [
                {
                  usage: {
                    inputTokens: 100,
                    outputTokens: 25,
                    totalTokens: 125,
                  },
                },
              ],
            },
          },
        } as AgentResult
      },
    }) as unknown as Agent
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent), {
      contextScope: '/workspace',
      contextWindow: async () => limit,
    })
    await collectStream(backend.stream('go'))

    const expected = {
      currentTokens: 100,
      projectedTokens: 125,
      contextWindow: limit ?? 1_000,
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    }
    expect(backend.contextUsage()).toEqual(expected)
    expect(saveSnapshot).toHaveBeenCalledWith({ target: agent, isLatest: true })

    const restoredAgent = {
      ...agent,
      messages: [user.clone(), assistant.clone()],
      sessionManager: undefined,
    } as unknown as Agent
    expect(
      new StrandsChatBackend(new AgentModelRuntime(restoredAgent), { contextScope: '/workspace' }).contextUsage()
    ).toEqual(expected)
    expect(
      new StrandsChatBackend(new AgentModelRuntime(restoredAgent), { contextScope: '/other-workspace' }).contextUsage()
    ).toBeUndefined()

    const differentModelAgent = {
      ...restoredAgent,
      model: {
        modelId: 'anthropic.claude-other',
        getConfig: () => ({ modelId: 'anthropic.claude-other', contextWindowLimit: 1_000 }),
      },
    } as unknown as Agent
    expect(
      new StrandsChatBackend(new AgentModelRuntime(differentModelAgent), { contextScope: '/workspace' }).contextUsage()
    ).toBeUndefined()

    expect(await backend.compact()).toBeUndefined()
    expect(backend.contextUsage()).toEqual(expected)

    messages.unshift(
      new Message({
        role: 'user',
        content: [new TextBlock('older context')],
      })
    )
    model.countTokens.mockResolvedValueOnce(1_500).mockResolvedValueOnce(1_400)
    const compacted = { currentTokens: 25, contextWindow: limit ?? 1_000 }
    expect(await backend.compact()).toEqual(compacted)
    expect(model.countTokens).toHaveBeenLastCalledWith(messages, { systemPrompt: 'system', toolSpecs: [] })
    expect(backend.contextUsage()).toEqual(compacted)
    expect(saveSnapshot).toHaveBeenCalledTimes(2)

    model.countTokens.mockRejectedValueOnce(new Error('count failed')).mockRejectedValueOnce(new Error('count failed'))
    messages.unshift(
      new Message({
        role: 'user',
        content: [new TextBlock('more older context')],
      })
    )
    expect(await backend.compact()).toEqual({ contextWindow: limit ?? 1_000 })
    expect(backend.contextUsage()).toEqual({ contextWindow: limit ?? 1_000 })

    messages.unshift(
      new Message({
        role: 'user',
        content: [new TextBlock('context without a reported size')],
      })
    )
    expect(await backend.compact()).toEqual({ currentTokens: 42, contextWindow: limit ?? 1_000 })

    summaryContent = []
    const beforeFailure = [...messages]
    await expect(backend.compact()).rejects.toThrow('The model did not return a usable summary. Try /compact again.')
    expect(messages).toEqual(beforeFailure)
  })

  it('includes provider-separated prompt-cache tokens in the latest context without using stale SDK totals', async () => {
    class BedrockModel {
      getConfig(): { contextWindowLimit: number } {
        return { contextWindowLimit: 1_000_000 }
      }
    }
    const agent = withSnapshotMethods({
      name: 'Strands harness',
      appState: { get: () => undefined },
      model: new BedrockModel(),
      tools: [],
      cancel: () => {},
      async *stream() {
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelMetadataEvent',
            usage: {
              inputTokens: 500,
              outputTokens: 25,
              totalTokens: 525,
            },
          },
        } as unknown as AgentStreamEvent
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelMetadataEvent',
            usage: {
              inputTokens: 2,
              outputTokens: 221,
              totalTokens: 10_689,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 10_466,
            },
          },
        } as unknown as AgentStreamEvent
        return {
          stopReason: 'endTurn',
          contextSize: 2,
          projectedContextSize: 223,
          metrics: {
            latestAgentInvocation: {
              usage: {
                inputTokens: 2,
                outputTokens: 221,
                totalTokens: 223,
                cacheReadInputTokens: 0,
                cacheWriteInputTokens: 10_466,
              },
            },
          },
        } as AgentResult
      },
    }) as unknown as Agent

    const { result } = await collectStream(new StrandsChatBackend(new AgentModelRuntime(agent)).stream('hello'))

    expect(result.context).toMatchObject({
      currentTokens: 10_468,
      projectedTokens: 10_689,
      contextWindow: 1_000_000,
    })
    expect(result.usage).toMatchObject({
      inputTokens: 10_468,
      outputTokens: 221,
      totalTokens: 10_689,
      cacheWriteInputTokens: 10_466,
    })
  })

  it('keeps delegated child events out of the root transcript', async () => {
    const root = withSnapshotMethods({
      name: 'Strands harness',
      appState: { get: () => undefined },
      model: { modelId: 'root-model', getConfig: () => ({}) },
      tools: [],
    }) as unknown as Agent
    const child = { name: 'Child' } as unknown as Agent
    root.stream = async function* () {
      yield {
        type: 'modelStreamUpdateEvent',
        agent: child,
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'child output' } },
      } as unknown as AgentStreamEvent
      yield {
        type: 'modelStreamUpdateEvent',
        agent: root,
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'root output' } },
      } as unknown as AgentStreamEvent
      return { stopReason: 'endTurn' } as AgentResult
    }
    const { events } = await collectStream(new StrandsChatBackend(new AgentModelRuntime(root)).stream('go'))

    expect(events).toEqual([
      { type: 'tasks', tasks: [] },
      { type: 'textDelta', text: 'root output' },
    ])
  })
})
