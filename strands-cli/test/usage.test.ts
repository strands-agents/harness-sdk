import { createElement } from 'react'
import { renderToString } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import {
  Agent,
  Model,
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  HookOrder,
  ModelStreamUpdateEvent,
  ToolStreamEvent,
  ToolStreamUpdateEvent,
  type JSONValue,
  type AgentResult,
  type AgentStreamEvent,
  type ModelStreamEvent,
} from '@strands-agents/sdk'

import { latestResultModelUsage, latestRootModelUsage, normalizeUsage, RunUsage } from '../src/usage.js'
import { projectAgentResult } from '../src/tui/chat/sdk-projector.js'
import { StrandsChatBackend } from '../src/tui/strands-backend.js'
import { AgentModelRuntime } from '../src/tui/model/runtime.js'
import { AcpService } from '../src/tui/acp/server.js'
import { runTurn, TurnRenderer } from '../src/cli/run.js'
import { createHarness, makeSubagent } from '@strands-agents/harness'
import { readBackgroundTasks } from '../src/tui/background/tasks.js'
import { ChatController } from '../src/tui/chat/controller.js'
import { ChatView } from '../src/tui/view/chat-view.js'

describe('usage normalization', () => {
  it('includes Anthropic cache reads and writes in prompt occupancy', () => {
    class AnthropicModel {}
    const usage = normalizeUsage(new AnthropicModel() as unknown as Model, {
      inputTokens: 4,
      outputTokens: 63,
      totalTokens: 67,
      cacheReadInputTokens: 3_288,
      cacheWriteInputTokens: 3_359,
    })

    expect(usage).toEqual({
      inputTokens: 6_651,
      outputTokens: 63,
      totalTokens: 6_714,
      cacheReadInputTokens: 3_288,
      cacheWriteInputTokens: 3_359,
    })
  })

  it('does not double-count cache tokens already included in provider input', () => {
    class OpenAIModel {}
    const usage = normalizeUsage(new OpenAIModel() as unknown as Model, {
      inputTokens: 1_000,
      outputTokens: 20,
      totalTokens: 1_020,
      cacheReadInputTokens: 900,
    })

    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 20,
      totalTokens: 1_020,
      cacheReadInputTokens: 900,
    })
  })

  it('reports only the exact total for Gemini on the pinned SDK', () => {
    class GoogleModel {}
    const usage = normalizeUsage(new GoogleModel() as unknown as Model, {
      inputTokens: 100,
      outputTokens: 55,
      totalTokens: 155,
      cacheReadInputTokens: 20,
    })

    expect(usage).toEqual({
      totalTokens: 155,
      cacheReadInputTokens: 20,
    })
  })
})

describe('latest model usage', () => {
  it('accepts root metadata and rejects delegated metadata', () => {
    const agent = {} as Agent
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const rootEvent = {
      type: 'modelStreamUpdateEvent',
      event: { type: 'modelMetadataEvent', usage },
    } as AgentStreamEvent
    const childEvent = { ...rootEvent, agent: {} as Agent } as unknown as AgentStreamEvent

    expect(latestRootModelUsage(agent, rootEvent)).toBe(usage)
    expect(latestRootModelUsage(agent, childEvent)).toBeUndefined()
  })

  it('recovers the final model call from per-cycle result metrics', () => {
    const finalUsage = { inputTokens: 90, outputTokens: 10, totalTokens: 100 }
    const result = {
      metrics: {
        latestAgentInvocation: {
          usage: { inputTokens: 140, outputTokens: 15, totalTokens: 155 },
          cycles: [
            {
              cycleId: 'cycle-1',
              duration: 1,
              usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
            },
            { cycleId: 'cycle-2', duration: 1, usage: finalUsage },
          ],
        },
      },
    } as AgentResult

    expect(latestResultModelUsage(result)).toBe(finalUsage)
  })
})

describe('delegated run usage', () => {
  class MeteredModel extends Model {
    private turn = 0
    constructor(
      private readonly input: number,
      private readonly output: number,
      private readonly child?: string,
      private readonly toolInput: JSONValue = { input: 'work' }
    ) {
      super()
    }
    getConfig() {
      return { modelId: 'metered', contextWindowLimit: 1000 }
    }
    updateConfig() {}
    async *stream(): AsyncIterable<ModelStreamEvent> {
      const delegate = this.turn++ === 0 ? this.child : undefined
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      if (delegate) {
        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: delegate, toolUseId: `use-${delegate}` },
        }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.toolInput) },
        }
      } else {
        yield { type: 'modelContentBlockStartEvent' }
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } }
      }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: delegate ? 'toolUse' : 'endTurn' }
      yield { type: 'modelMetadataEvent', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield {
        type: 'modelMetadataEvent',
        usage: { inputTokens: this.input, outputTokens: this.output, totalTokens: this.input + this.output },
      }
    }
  }

  it('counts child and grandchild calls once while keeping root context separate and resetting next run', async () => {
    const grandchild = new Agent({ name: 'grandchild', model: new MeteredModel(90, 10), printer: false })
    const child = new Agent({
      name: 'child',
      model: new MeteredModel(20, 5, 'grandchild'),
      tools: [grandchild.asTool()],
      printer: false,
    })
    const root = new Agent({ model: new MeteredModel(5, 3, 'child'), tools: [child.asTool()], printer: false })
    const totals: number[] = []
    for (let turn = 0; turn < 2; turn++) {
      const usage = RunUsage.start(root)
      let latest
      const stream = root.stream('work')
      let next = await stream.next()
      while (!next.done) {
        usage.observe(next.value)
        latest = latestRootModelUsage(root, next.value) ?? latest
        next = await stream.next()
      }
      const projected = projectAgentResult(root, next.value, latest, usage.total())
      totals.push(projected.usage!.totalTokens)
      expect(projected.context).toMatchObject({ currentTokens: 5, projectedTokens: 8 })
    }
    expect(totals).toEqual([166, 8])
  })

  it.each(['backend', 'acp', 'plain'] as const)(
    'includes subagent and background grandchild usage through %s without using their context size',
    async (mode) => {
      const grandchild = new Agent({ name: 'grandchild', model: new MeteredModel(90, 10), printer: false })
      const child = new Agent({
        name: 'child',
        model: new MeteredModel(20, 5, 'grandchild'),
        tools: [grandchild.asTool()],
        backgroundTasks: { always: ['grandchild'], waitForCompletion: true },
        printer: false,
      })
      const root = new Agent({
        model: new MeteredModel(5, 3, 'subagent', { task: 'work' }),
        tools: [makeSubagent({ builder: () => child })],
        printer: false,
      })
      // Two root calls, three child calls (including background delivery), one grandchild call.
      const expected = 2 * 8 + 3 * 25 + 100
      if (mode === 'backend') {
        const backend = new StrandsChatBackend(new AgentModelRuntime(root))
        try {
          const stream = backend.stream('work')
          let next = await stream.next()
          while (!next.done) {
            next = await stream.next()
          }
          expect(next.value.usage?.totalTokens).toBe(expected)
          expect(next.value.context).toMatchObject({ currentTokens: 5, projectedTokens: 8 })
        } finally {
          await backend.dispose()
        }
      } else if (mode === 'acp') {
        const service = new AcpService({ session: false }, { buildAgent: async () => root, sourceAgent: true })
        const notify = vi.fn(async () => {})
        try {
          const session = await service.newSession({ cwd: process.cwd(), mcpServers: [] })
          const result = await service.prompt(
            { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'work' }] },
            { notify } as unknown as Parameters<AcpService['prompt']>[1]
          )
          expect(result.usage?.totalTokens).toBe(expected)
          expect(notify).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ update: { sessionUpdate: 'usage_update', used: 8, size: 1000 } })
          )
        } finally {
          await service.dispose()
        }
      } else {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
        try {
          await runTurn(root, 'work')
          expect(write.mock.calls.map(([text]) => String(text)).join('')).toContain(`${expected} tokens`)
        } finally {
          write.mockRestore()
        }
      }
    }
  )

  async function detachedAgents(): Promise<{ root: Agent; child: Agent; release: () => void }> {
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    class DeferredModel extends MeteredModel {
      override async *stream(): AsyncIterable<ModelStreamEvent> {
        await ready
        yield* super.stream()
      }
    }
    const child = new Agent({ name: 'child', model: new DeferredModel(90, 10), printer: false })
    const root = await createHarness({
      model: new MeteredModel(5, 3, 'subagent', { task: 'work' }),
      tools: [makeSubagent({ builder: () => child })],
      builtinTools: [],
      builtinPlugins: [],
      backgroundTasks: { waitForCompletion: false },
      session: false,
      memory: false,
      caching: false,
      contextManager: false,
      skills: false,
      printer: false,
    })
    return { root, child, release }
  }

  it('waits for background retries decided by late hooks before reporting final spend', async () => {
    const { root, child, release } = await detachedAgents()
    let releaseRetry!: () => void
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve
    })
    let childInvocations = 0
    child.addHook(BeforeInvocationEvent, async () => {
      if (++childInvocations === 2) {
        await retryGate
      }
    })
    let attempts = 0
    root.addHook(
      AfterToolCallEvent,
      (event) => {
        if (event.toolUse.name === 'subagent') {
          event.retry = ++attempts === 1
        }
      },
      { order: HookOrder.SDK_LAST }
    )
    const usage = RunUsage.start(root)
    const completed = vi.fn()
    try {
      await root.invoke('work')
      usage.onComplete(completed)
      release()
      await vi.waitFor(() => expect(childInvocations).toBe(2))
      expect(usage.total()).toMatchObject({ totalTokens: 116, incomplete: true })
      expect(completed).not.toHaveBeenCalled()
      releaseRetry()
      await vi.waitFor(() => {
        expect(readBackgroundTasks(root)).toEqual([expect.objectContaining({ status: 'completed' })])
      })
      expect(attempts).toBe(2)
      expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ totalTokens: 216 }))
      expect(completed.mock.calls[0]?.[0]).not.toHaveProperty('incomplete')
      expect(usage.total()?.totalTokens).toBe(216)
      const delivery = RunUsage.start(root)
      await root.invoke('continue')
      expect(delivery.total()?.totalTokens).toBe(8)
      expect(usage.total()?.totalTokens).toBe(216)
    } finally {
      release()
      releaseRetry()
      root.cancel()
    }
  })

  it.each(['after turn', 'before subscription'] as const)(
    'displays completed detached spend on the originating TUI turn when it finishes %s',
    async (timing) => {
      const { root, release } = await detachedAgents()
      let finishContext!: () => void
      let contextStarted!: () => void
      const contextGate = new Promise<void>((resolve) => {
        finishContext = resolve
      })
      const contextReady = new Promise<void>((resolve) => {
        contextStarted = resolve
      })
      const backend = new StrandsChatBackend(new AgentModelRuntime(root, { backgroundTasksWaitForCompletion: false }), {
        contextWindow: async () => {
          contextStarted()
          await contextGate
          return 1000
        },
      })
      const controller = new ChatController(backend)
      const finalizedContext = vi.fn()
      const stopWatching = controller.subscribe(() => {
        const snapshot = controller.getSnapshot()
        if (snapshot.context.totalTokens === 116) {
          finalizedContext(snapshot.context)
        }
      })
      try {
        const submitting = controller.submit('work')
        await contextReady
        if (timing === 'before subscription') {
          release()
          await vi.waitFor(() => {
            expect(readBackgroundTasks(root)).toEqual([expect.objectContaining({ status: 'completed' })])
          })
        }
        finishContext()
        await submitting
        const initial = controller.getSnapshot()
        if (timing === 'after turn') {
          expect(initial.completedTurns[0]?.usage).toBeUndefined()
          release()
        }
        await vi.waitFor(() => {
          expect(controller.getSnapshot().completedTurns[0]?.usage?.totalTokens).toBe(116)
        })
        expect(finalizedContext).toHaveBeenCalledWith({
          currentTokens: 5,
          projectedTokens: 8,
          contextWindow: 1000,
          inputTokens: 100,
          outputTokens: 16,
          totalTokens: 116,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        })
        await vi.waitFor(() => {
          expect(controller.getSnapshot().completedTurns[1]).toMatchObject({
            source: 'background',
            usage: { totalTokens: 8 },
          })
        })
        const snapshot = controller.getSnapshot()
        expect(snapshot.completedTurns.map((turn) => turn.usage?.totalTokens)).toEqual([116, 8])
        expect(snapshot.context).toMatchObject({ currentTokens: 5, projectedTokens: 8, totalTokens: 8 })
        expect(
          renderToString(
            createElement(ChatView, { snapshot, input: '', cursor: 0, terminalWidth: 100, terminalHeight: 40 })
          )
        ).toContain('116 tokens')
        if (timing === 'after turn') {
          expect(initial.completedTurns[0]?.usage).toBeUndefined()
        }
      } finally {
        stopWatching()
        release()
        finishContext()
        await controller.dispose()
      }
    }
  )

  it('keeps detached subagent spend with its originating run and installs hooks only once per agent', async () => {
    const { root, child, release } = await detachedAgents()
    await root.initialize()
    await child.initialize()
    const rootHooks = vi.spyOn(root, 'addHook')
    const childHooks = vi.spyOn(child, 'addHook')
    const usage = RunUsage.start(root)
    try {
      const result = await root.invoke('work')
      expect(readBackgroundTasks(root)).toEqual([expect.objectContaining({ label: 'subagent' })])
      const reported = usage.total()
      expect(reported).toMatchObject({ totalTokens: 16, incomplete: true })
      const projected = projectAgentResult(root, result, undefined, reported)
      expect(projected.usage).toBeUndefined()
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      try {
        new TurnRenderer(root.model).finish(undefined, reported)
        expect(write.mock.calls.map(([text]) => String(text)).join('')).toContain(
          '16 tokens so far; background usage incomplete'
        )
      } finally {
        write.mockRestore()
      }
      const nextUsage = RunUsage.start(root)
      release()
      await vi.waitFor(() => {
        expect(readBackgroundTasks(root)).toEqual([expect.objectContaining({ status: 'completed' })])
      })
      expect(usage.total()).toMatchObject({ totalTokens: 116 })
      expect(usage.total()).not.toHaveProperty('incomplete')
      expect(reported).toMatchObject({ totalTokens: 16, incomplete: true })
      expect(projected.usage).toBeUndefined()
      expect(nextUsage.total()).toBeUndefined()
      await root.invoke('continue')
      expect(nextUsage.total()?.totalTokens).toBe(8)
      expect(usage.total()?.totalTokens).toBe(116)
      expect(rootHooks).toHaveBeenCalledTimes(7)
      expect(childHooks).toHaveBeenCalledTimes(7)
      await child.invoke('unrelated invocation')
      expect(usage.total()?.totalTokens).toBe(116)
    } finally {
      release()
      root.cancel()
      rootHooks.mockRestore()
      childHooks.mockRestore()
    }
  })

  it('retains the latest metadata on a failed nested model call', () => {
    const agent = new Agent({ model: new MeteredModel(1, 1), printer: false })
    const usage = new RunUsage()
    const observeChild = (event: AgentStreamEvent): void => {
      usage.observe(
        new ToolStreamUpdateEvent({
          agent,
          invocationState: {},
          event: new ToolStreamEvent({
            data: new ToolStreamUpdateEvent({
              agent,
              invocationState: {},
              event: new ToolStreamEvent({ data: event }),
            }),
          }),
        })
      )
    }
    observeChild(new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} }))
    for (const tokens of [10, 15]) {
      observeChild(
        new ModelStreamUpdateEvent({
          agent,
          invocationState: {},
          event: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: tokens - 5, outputTokens: 5, totalTokens: tokens },
          },
        })
      )
    }
    observeChild(
      new AfterModelCallEvent({
        agent,
        model: agent.model,
        invocationState: {},
        attemptCount: 1,
        error: new Error('output limit'),
      })
    )
    expect(usage.total()?.totalTokens).toBe(15)
  })
})
