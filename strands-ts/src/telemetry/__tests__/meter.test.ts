import { describe, it, expect, vi, beforeEach } from 'vitest'
import { metrics as otelMetrics, type Meter as OtelMeter } from '@opentelemetry/api'
import { Meter, AgentMetrics } from '../meter.js'
import { MockMeter } from '../../__fixtures__/mock-meter.js'
import type { ToolUse } from '../../tools/types.js'

describe('Meter', () => {
  const makeTool = (name: string, toolUseId: string): ToolUse => ({
    name,
    toolUseId,
    input: {},
  })

  let meter: Meter

  beforeEach(() => {
    meter = new Meter()
  })

  describe('metrics getter', () => {
    it('returns an AgentMetrics instance', () => {
      expect(meter.metrics).toBeInstanceOf(AgentMetrics)
    })

    it('returns zeroed snapshot for fresh instance', () => {
      const snapshot = meter.metrics
      expect(snapshot).toStrictEqual(
        new AgentMetrics({
          cycleCount: 0,
          toolMetrics: {},
          agentInvocations: [],
          accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          accumulatedMetrics: { latencyMs: 0 },
        })
      )
    })

    it('returns complete snapshot after a realistic agent execution', () => {
      vi.useFakeTimers()
      vi.setSystemTime(100_000)

      meter.startNewInvocation()

      const c1 = meter.startCycle()
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 100 },
      })
      meter.endToolCall({
        tool: makeTool('search', 'tid-1'),
        duration: 0.5,
        success: true,
      })
      vi.setSystemTime(103_000)
      meter.endCycle(c1.startTime)

      vi.setSystemTime(200_000)
      const c2 = meter.startCycle()
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        metrics: { latencyMs: 250 },
      })
      meter.endToolCall({
        tool: makeTool('search', 'tid-2'),
        duration: 1.5,
        success: false,
      })
      vi.setSystemTime(205_000)
      meter.endCycle(c2.startTime)

      const snapshot = meter.metrics

      expect(snapshot.cycleCount).toBe(2)
      expect(snapshot.totalDuration).toBe(8000)
      expect(snapshot.accumulatedUsage).toStrictEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 })
      expect(snapshot.accumulatedMetrics).toStrictEqual({ latencyMs: 350 })
      expect(snapshot.toolMetrics).toStrictEqual({
        search: {
          callCount: 2,
          successCount: 1,
          errorCount: 1,
          totalTime: 2.0,
        },
      })
      expect(snapshot.agentInvocations).toStrictEqual([
        {
          usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
          cycles: [
            { cycleId: 'cycle-1', duration: 3000, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
            { cycleId: 'cycle-2', duration: 5000, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
          ],
        },
      ])

      vi.useRealTimers()
    })

    it('tracks multiple invocations independently', () => {
      meter.startNewInvocation()
      meter.startCycle()
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })

      meter.startNewInvocation()
      meter.startCycle()
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      })

      expect(meter.metrics.agentInvocations).toStrictEqual([
        {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          cycles: [{ cycleId: 'cycle-1', duration: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
        },
        {
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          cycles: [{ cycleId: 'cycle-2', duration: 0, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }],
        },
      ])
    })
  })

  describe('startNewInvocation', () => {
    it('appends an invocation with empty cycles and zeroed usage', () => {
      meter.startNewInvocation()

      expect(meter.metrics.agentInvocations).toStrictEqual([
        { cycles: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      ])
    })

    it('latestAgentInvocation returns the most recently added invocation', () => {
      meter.startNewInvocation()
      meter.startNewInvocation()

      const snapshot = meter.metrics
      expect(snapshot.agentInvocations).toHaveLength(2)
      expect(snapshot.latestAgentInvocation).toBe(snapshot.agentInvocations[1])
    })

    it('evicts oldest entries when exceeding max history cap', () => {
      for (let i = 0; i < 60; i++) {
        meter.startNewInvocation()
        meter.startCycle()
      }

      const invocations = meter.metrics.agentInvocations
      expect(invocations).toHaveLength(50)
      // First retained entry is the 11th invocation (oldest 10 were evicted)
      expect(invocations[0]!.cycles[0]!.cycleId).toBe('cycle-11')
      expect(invocations[49]!.cycles[0]!.cycleId).toBe('cycle-60')
    })
  })

  describe('startCycle', () => {
    it('returns cycle id and start time', () => {
      vi.useFakeTimers()
      vi.setSystemTime(100_000)

      const result = meter.startCycle()

      expect(result).toStrictEqual({
        cycleId: 'cycle-1',
        startTime: 100_000,
      })
      expect(meter.metrics.cycleCount).toBe(1)
      vi.useRealTimers()
    })

    it('adds cycle entry to the latest invocation', () => {
      meter.startNewInvocation()
      meter.startCycle()

      expect(meter.metrics.latestAgentInvocation!.cycles).toStrictEqual([
        { cycleId: 'cycle-1', duration: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      ])
    })

    it('does not fail when no invocation exists', () => {
      const result = meter.startCycle()

      expect(result.cycleId).toBe('cycle-1')
      expect(meter.metrics.agentInvocations).toStrictEqual([])
    })
  })

  describe('endCycle', () => {
    it('records duration on the latest cycle', () => {
      vi.useFakeTimers()
      vi.setSystemTime(200_000)

      meter.startNewInvocation()
      meter.startCycle()
      meter.endCycle(100_000)

      expect(meter.metrics.latestAgentInvocation!.cycles[0]!.duration).toBe(100_000)
      vi.useRealTimers()
    })

    it('does not fail when no invocation exists', () => {
      vi.useFakeTimers()
      vi.setSystemTime(200_000)

      meter.startCycle()

      expect(() => meter.endCycle(100_000)).not.toThrow()
      expect(meter.metrics.agentInvocations).toStrictEqual([])
      vi.useRealTimers()
    })

    it('does not fail when invocation has no cycles', () => {
      vi.useFakeTimers()
      vi.setSystemTime(200_000)

      meter.startNewInvocation()

      expect(() => meter.endCycle(100_000)).not.toThrow()
      expect(meter.metrics.latestAgentInvocation!.cycles).toStrictEqual([])
      vi.useRealTimers()
    })
  })

  describe('endToolCall', () => {
    it('records success', () => {
      meter.endToolCall({
        tool: makeTool('myTool', 'id-1'),
        duration: 1.5,
        success: true,
      })

      expect(meter.metrics.toolMetrics).toStrictEqual({
        myTool: { callCount: 1, successCount: 1, errorCount: 0, totalTime: 1.5 },
      })
    })

    it('records failure', () => {
      meter.endToolCall({
        tool: makeTool('myTool', 'id-1'),
        duration: 0.5,
        success: false,
      })

      expect(meter.metrics.toolMetrics).toStrictEqual({
        myTool: { callCount: 1, successCount: 0, errorCount: 1, totalTime: 0.5 },
      })
    })

    it('accumulates across multiple calls to the same tool', () => {
      meter.endToolCall({
        tool: makeTool('myTool', 'id-1'),
        duration: 1.0,
        success: true,
      })
      meter.endToolCall({
        tool: makeTool('myTool', 'id-2'),
        duration: 2.0,
        success: false,
      })

      expect(meter.metrics.toolMetrics).toStrictEqual({
        myTool: { callCount: 2, successCount: 1, errorCount: 1, totalTime: 3.0 },
      })
    })

    it('tracks different tools independently', () => {
      meter.endToolCall({
        tool: makeTool('toolA', 'id-1'),
        duration: 1.0,
        success: true,
      })
      meter.endToolCall({
        tool: makeTool('toolB', 'id-2'),
        duration: 2.0,
        success: false,
      })

      expect(meter.metrics.toolMetrics).toStrictEqual({
        toolA: { callCount: 1, successCount: 1, errorCount: 0, totalTime: 1.0 },
        toolB: { callCount: 1, successCount: 0, errorCount: 1, totalTime: 2.0 },
      })
    })
  })

  describe('latestContextSize', () => {
    it('is undefined when no invocations have occurred', () => {
      expect(meter.metrics.latestContextSize).toBeUndefined()
    })

    it('returns the most recent inputTokens after a model call', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })

      expect(meter.metrics.latestContextSize).toBe(100)
    })

    it('updates across multiple cycles', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      })

      expect(meter.metrics.latestContextSize).toBe(200)
    })

    it('updates across multiple invocations', () => {
      meter.startNewInvocation()
      meter.startCycle()
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })

      meter.startNewInvocation()
      meter.startCycle()
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
      })

      expect(meter.metrics.latestContextSize).toBe(300)
    })

    it('remains undefined when metadata has no usage', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        metrics: { latencyMs: 100 },
      })

      expect(meter.metrics.latestContextSize).toBeUndefined()
    })

    it('remains undefined when updateCycle is called with undefined', () => {
      meter.updateCycle(undefined)

      expect(meter.metrics.latestContextSize).toBeUndefined()
    })

    // Regression for #3546: a large cache read on a disjoint provider (Bedrock/Anthropic) must be
    // counted, or context utilization reads as tiny and proactive compaction never fires.
    it('counts cache reads on disjoint providers where they add to inputTokens', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 5862, cacheReadInputTokens: 5848 },
      })

      expect(meter.metrics.latestContextSize).toBe(5858)
    })

    // Regression for #3546: on subset providers (OpenAI/Gemini) the cache read already sits inside
    // inputTokens, so it must not be added again.
    it('does not double-count cache reads on subset providers', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 12936, outputTokens: 10, totalTokens: 12946, cacheReadInputTokens: 6457 },
      })

      expect(meter.metrics.latestContextSize).toBe(12936)
    })
  })

  describe('projectedContextSize', () => {
    it('is undefined when no invocations have occurred', () => {
      expect(meter.metrics.projectedContextSize).toBeUndefined()
    })

    it('returns inputTokens + outputTokens after a model call', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })

      expect(meter.metrics.projectedContextSize).toBe(150)
    })

    it('updates across multiple cycles', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      })

      expect(meter.metrics.projectedContextSize).toBe(280)
    })

    // Regression for #3546: projects total prompt + output on a disjoint provider.
    it('counts cache reads on disjoint providers where they add to inputTokens', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 5862, cacheReadInputTokens: 5848 },
      })

      expect(meter.metrics.projectedContextSize).toBe(5862)
    })

    // Regression for #3546: projects total prompt + output on a subset provider without double-counting.
    it('does not double-count cache reads on subset providers', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 12936, outputTokens: 10, totalTokens: 12946, cacheReadInputTokens: 6457 },
      })

      expect(meter.metrics.projectedContextSize).toBe(12946)
    })
  })

  describe('updateCycle', () => {
    it('accumulates usage and latency from metadata', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        metrics: { latencyMs: 100 },
      })
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 },
        metrics: { latencyMs: 200 },
      })

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 15,
        outputTokens: 10,
        totalTokens: 25,
      })
      expect(meter.metrics.accumulatedMetrics).toStrictEqual({ latencyMs: 300 })
    })

    it('accumulates cache tokens across calls', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
        },
      })
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          cacheReadInputTokens: 4,
        },
      })

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 15,
        outputTokens: 7,
        totalTokens: 22,
        cacheReadInputTokens: 7,
        cacheWriteInputTokens: 2,
      })
    })

    it('handles usage-only metadata', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      })
      expect(meter.metrics.accumulatedMetrics).toStrictEqual({ latencyMs: 0 })
    })

    it('handles metrics-only metadata', () => {
      meter.updateCycle({
        type: 'modelMetadataEvent',
        metrics: { latencyMs: 250 },
      })

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })
      expect(meter.metrics.accumulatedMetrics).toStrictEqual({ latencyMs: 250 })
    })

    it('propagates usage to invocation and current cycle', () => {
      meter.startNewInvocation()
      meter.startCycle()

      meter.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })

      const invocation = meter.metrics.latestAgentInvocation!
      expect(invocation).toStrictEqual({
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cycles: [{ cycleId: 'cycle-1', duration: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }],
      })
    })

    it('is a no-op when metadata is undefined', () => {
      meter.updateCycle(undefined)

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })
      expect(meter.metrics.accumulatedMetrics).toStrictEqual({ latencyMs: 0 })
    })

    it('is a no-op when called with no arguments', () => {
      meter.updateCycle()

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })
      expect(meter.metrics.accumulatedMetrics).toStrictEqual({ latencyMs: 0 })
    })

    it('is a no-op when metadata has neither usage nor metrics', () => {
      meter.updateCycle({ type: 'modelMetadataEvent' })

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })
      expect(meter.metrics.accumulatedMetrics).toStrictEqual({ latencyMs: 0 })
    })

    it('does not fail when no invocation exists', () => {
      expect(() => {
        meter.updateCycle({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })
      }).not.toThrow()

      expect(meter.metrics.accumulatedUsage).toStrictEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      })
    })
  })

  describe('OTEL instrument emission', () => {
    let mockMeter: MockMeter

    beforeEach(() => {
      mockMeter = new MockMeter()
      vi.spyOn(otelMetrics, 'getMeter').mockReturnValue(mockMeter as unknown as OtelMeter)
    })

    it('emits invocation counter on startNewInvocation', () => {
      const m = new Meter()

      m.startNewInvocation()

      expect(mockMeter.getCounter('gen_ai.agent.invocation.count')?.sum).toBe(1)
    })

    it('emits cycle counter on startCycle', () => {
      const m = new Meter()

      m.startCycle()

      expect(mockMeter.getCounter('gen_ai.agent.cycle.count')?.sum).toBe(1)
    })

    it('emits cycle duration histogram on endCycle', () => {
      vi.useFakeTimers()
      vi.setSystemTime(5000)
      const m = new Meter()

      m.endCycle(3000)

      expect(mockMeter.getHistogram('gen_ai.agent.cycle.duration')?.sum).toBe(2000)
      vi.useRealTimers()
    })

    it('emits tool call counter and duration on successful endToolCall', () => {
      const m = new Meter()

      m.endToolCall({ tool: makeTool('search', 'id-1'), duration: 150, success: true })

      expect(mockMeter.getCounter('gen_ai.agent.tool.call.count')?.dataPoints).toStrictEqual([
        { value: 1, attributes: { 'gen_ai.tool.name': 'search' } },
      ])
      expect(mockMeter.getHistogram('gen_ai.agent.tool.duration')?.dataPoints).toStrictEqual([
        { value: 150, attributes: { 'gen_ai.tool.name': 'search' } },
      ])
      expect(mockMeter.getCounter('gen_ai.agent.tool.error.count')?.dataPoints).toStrictEqual([])
    })

    it('emits tool call counter, error counter, and duration on failed endToolCall', () => {
      const m = new Meter()

      m.endToolCall({ tool: makeTool('search', 'id-1'), duration: 50, success: false })

      expect(mockMeter.getCounter('gen_ai.agent.tool.call.count')?.dataPoints).toStrictEqual([
        { value: 1, attributes: { 'gen_ai.tool.name': 'search' } },
      ])
      expect(mockMeter.getCounter('gen_ai.agent.tool.error.count')?.dataPoints).toStrictEqual([
        { value: 1, attributes: { 'gen_ai.tool.name': 'search' } },
      ])
      expect(mockMeter.getHistogram('gen_ai.agent.tool.duration')?.dataPoints).toStrictEqual([
        { value: 50, attributes: { 'gen_ai.tool.name': 'search' } },
      ])
    })

    it('emits input token counter, output token counter, and model latency on updateCycle', () => {
      const m = new Meter()

      m.updateCycle({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        metrics: { latencyMs: 200 },
      })

      expect(mockMeter.getCounter('gen_ai.agent.tokens.input')?.sum).toBe(100)
      expect(mockMeter.getCounter('gen_ai.agent.tokens.output')?.sum).toBe(50)
      expect(mockMeter.getHistogram('gen_ai.agent.model.latency')?.sum).toBe(200)
    })

    it('does not emit token counters or latency when updateCycle has no usage or metrics', () => {
      const m = new Meter()

      m.updateCycle({ type: 'modelMetadataEvent' })

      expect(mockMeter.getCounter('gen_ai.agent.tokens.input')?.dataPoints).toStrictEqual([])
      expect(mockMeter.getCounter('gen_ai.agent.tokens.output')?.dataPoints).toStrictEqual([])
      expect(mockMeter.getHistogram('gen_ai.agent.model.latency')?.dataPoints).toStrictEqual([])
    })

    it('does not emit any OTEL instruments when updateCycle is called with undefined', () => {
      const m = new Meter()

      m.updateCycle(undefined)

      expect(mockMeter.getCounter('gen_ai.agent.tokens.input')?.dataPoints).toStrictEqual([])
      expect(mockMeter.getCounter('gen_ai.agent.tokens.output')?.dataPoints).toStrictEqual([])
      expect(mockMeter.getHistogram('gen_ai.agent.model.latency')?.dataPoints).toStrictEqual([])
    })

    it('emits time-to-first-token histogram in seconds when timeToFirstByteMs is provided', () => {
      const m = new Meter()

      m.updateCycle({
        type: 'modelMetadataEvent',
        metrics: { latencyMs: 500, timeToFirstByteMs: 150 },
      })

      expect(mockMeter.getHistogram('gen_ai.server.time_to_first_token')?.sum).toBeCloseTo(0.15)
    })

    it('does not emit time-to-first-token histogram when timeToFirstByteMs is undefined', () => {
      const m = new Meter()

      m.updateCycle({
        type: 'modelMetadataEvent',
        metrics: { latencyMs: 500 },
      })

      expect(mockMeter.getHistogram('gen_ai.server.time_to_first_token')?.dataPoints).toStrictEqual([])
    })

    it('does not emit time-to-first-token histogram when timeToFirstByteMs is zero', () => {
      const m = new Meter()

      m.updateCycle({
        type: 'modelMetadataEvent',
        metrics: { latencyMs: 500, timeToFirstByteMs: 0 },
      })

      expect(mockMeter.getHistogram('gen_ai.server.time_to_first_token')?.dataPoints).toStrictEqual([])
    })
  })
})

describe('AgentMetrics', () => {
  describe('toJSON', () => {
    it('returns complete zeroed data for default instance', () => {
      const metrics = new AgentMetrics()
      expect(metrics.toJSON()).toStrictEqual({
        cycleCount: 0,
        accumulatedUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        accumulatedMetrics: { latencyMs: 0 },
        agentInvocations: [],
        toolMetrics: {},
        totalDuration: 0,
      })
    })

    it('returns data from provided metrics', () => {
      const metrics = new AgentMetrics({
        cycleCount: 2,
        totalDuration: 8000,
        toolMetrics: {
          search: { callCount: 2, successCount: 1, errorCount: 1, totalTime: 2.0 },
        },
        accumulatedUsage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
        accumulatedMetrics: { latencyMs: 350 },
        agentInvocations: [
          {
            usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
            cycles: [
              { cycleId: 'cycle-1', duration: 3000, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
              { cycleId: 'cycle-2', duration: 5000, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
            ],
          },
        ],
      })

      expect(metrics.toJSON()).toStrictEqual({
        cycleCount: 2,
        accumulatedUsage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
        accumulatedMetrics: { latencyMs: 350 },
        agentInvocations: [
          {
            usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
            cycles: [
              { cycleId: 'cycle-1', duration: 3000, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
              { cycleId: 'cycle-2', duration: 5000, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
            ],
          },
        ],
        toolMetrics: {
          search: { callCount: 2, successCount: 1, errorCount: 1, totalTime: 2.0 },
        },
        totalDuration: 8000,
      })
    })
  })

  describe('toJSON with latestContextSize', () => {
    it('includes latestContextSize when set', () => {
      const metrics = new AgentMetrics({ latestContextSize: 42 })
      expect(metrics.toJSON()).toHaveProperty('latestContextSize', 42)
    })

    it('omits latestContextSize when undefined', () => {
      const metrics = new AgentMetrics()
      expect(metrics.toJSON()).not.toHaveProperty('latestContextSize')
    })
  })

  describe('toJSON roundtrip', () => {
    it('reconstructs equivalent AgentMetrics from serialized data', () => {
      const original = new AgentMetrics({
        cycleCount: 3,
        accumulatedUsage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
        accumulatedMetrics: { latencyMs: 500 },
        agentInvocations: [
          {
            usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
            cycles: [
              { cycleId: 'cycle-1', duration: 1000, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
              { cycleId: 'cycle-2', duration: 2000, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
              { cycleId: 'cycle-3', duration: 3000, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
            ],
          },
        ],
        toolMetrics: {
          search: { callCount: 2, successCount: 2, errorCount: 0, totalTime: 1.5 },
          calc: { callCount: 1, successCount: 0, errorCount: 1, totalTime: 0.3 },
        },
      })

      const json = JSON.stringify(original)
      const restored = new AgentMetrics(JSON.parse(json))

      expect(restored.toJSON()).toStrictEqual(original.toJSON())
    })
  })

  describe('computed getters', () => {
    it('latestAgentInvocation returns the last invocation', () => {
      const metrics = new AgentMetrics({
        agentInvocations: [
          { cycles: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { cycles: [], usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
        ],
      })

      expect(metrics.latestAgentInvocation).toBe(metrics.agentInvocations[1])
    })

    it('latestAgentInvocation returns undefined when empty', () => {
      const metrics = new AgentMetrics()
      expect(metrics.latestAgentInvocation).toBeUndefined()
    })

    it('accumulatedData returns usage and metrics together', () => {
      const metrics = new AgentMetrics({
        accumulatedUsage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
        accumulatedMetrics: { latencyMs: 350 },
      })

      expect(metrics.accumulatedData).toStrictEqual({
        usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 },
        metrics: { latencyMs: 350 },
      })
    })

    it('averageCycleTime computes average', () => {
      const metrics = new AgentMetrics({
        cycleCount: 2,
        totalDuration: 8000,
      })
      expect(metrics.averageCycleTime).toBe(4000)
    })

    it('averageCycleTime returns 0 when no cycles', () => {
      const metrics = new AgentMetrics()
      expect(metrics.averageCycleTime).toBe(0)
    })

    it('toolUsage adds computed averageTime and successRate', () => {
      const metrics = new AgentMetrics({
        toolMetrics: {
          search: { callCount: 2, successCount: 1, errorCount: 1, totalTime: 2.0 },
        },
      })

      expect(metrics.toolUsage).toStrictEqual({
        search: {
          callCount: 2,
          successCount: 1,
          errorCount: 1,
          totalTime: 2.0,
          averageTime: 1.0,
          successRate: 0.5,
        },
      })
    })

    it('toolUsage returns 0 for averageTime and successRate when callCount is 0', () => {
      const metrics = new AgentMetrics({
        toolMetrics: {
          broken: { callCount: 0, successCount: 0, errorCount: 0, totalTime: 0 },
        },
      })

      expect(metrics.toolUsage).toStrictEqual({
        broken: {
          callCount: 0,
          successCount: 0,
          errorCount: 0,
          totalTime: 0,
          averageTime: 0,
          successRate: 0,
        },
      })
    })
  })
})
