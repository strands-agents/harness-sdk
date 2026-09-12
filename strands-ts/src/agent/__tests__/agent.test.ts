import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Agent, type ToolList } from '../agent.js'
import { SessionManager } from '../../session/session-manager.js'
import { McpClient } from '../../mcp/index.js'
import { McpTool } from '../../tools/mcp-tool.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createMockTool, createRandomTool } from '../../__fixtures__/tool-helpers.js'
import { ConcurrentInvocationError } from '../../errors.js'
import {
  MaxTokensError,
  TextBlock,
  CachePointBlock,
  Message,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  GuardContentBlock,
  AudioBlock,
  ImageBlock,
  VideoBlock,
  DocumentBlock,
} from '../../index.js'
import { AgentPrinter } from '../printer.js'
import {
  AfterInvocationEvent,
  AfterToolCallEvent,
  AfterToolsEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolsEvent,
} from '../../hooks/events.js'
import { BedrockModel } from '../../models/bedrock.js'
import { StructuredOutputError } from '../../errors.js'
import { expectLoopMetrics } from '../../__fixtures__/metrics-helpers.js'
import { expectAgentResult } from '../../__fixtures__/agent-helpers.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'
import type { StreamOptions } from '../../index.js'
import type { ModelStreamEvent } from '../../models/streaming.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'

describe('Agent', () => {
  describe('stream', () => {
    describe('basic streaming', () => {
      it('returns AsyncGenerator', () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        const result = agent.stream('Test prompt')

        expect(result).toBeDefined()
        expect(typeof result[Symbol.asyncIterator]).toBe('function')
      })

      it('returns AsyncGenerator that can be iterated without type errors', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        // Ensures that the signature of agent.stream is correct
        for await (const _ of agent.stream('Test prompt')) {
          /* intentionally empty */
        }
      })

      it('yields AgentStreamEvent objects', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        const { items } = await collectGenerator(agent.stream('Test prompt'))

        expect(items.length).toBeGreaterThan(0)
        const firstItem = items[0]
        expect(firstItem).toEqual(new BeforeInvocationEvent({ agent: agent, invocationState: {} }))
      })

      it('returns AgentResult as generator return value', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        const { result } = await collectGenerator(agent.stream('Test prompt'))

        expect(result).toEqual(
          expectAgentResult({
            stopReason: 'endTurn',
            messageText: 'Hello',
            cycleCount: 1,
            traceCount: 1,
          })
        )
        // Verify trace structure
        expect(result.traces?.[0]?.children).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'stream_messages' })])
        )
      })
    })

    describe('with tool use', () => {
      it('handles tool execution flow', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Tool result processed' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('Tool executed')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const { items, result } = await collectGenerator(agent.stream('Use the tool'))

        // Check that tool-related events are yielded
        const toolEvents = items.filter(
          (event) => event.type === 'beforeToolsEvent' || event.type === 'afterToolsEvent'
        )
        expect(toolEvents.length).toBeGreaterThan(0)

        // Check final result
        expect(result.stopReason).toBe('endTurn')
      })

      it('yields tool-related events', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('Success')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const { items } = await collectGenerator(agent.stream('Test'))

        const beforeTools = items.find((e) => e.type === 'beforeToolsEvent')
        const afterTools = items.find((e) => e.type === 'afterToolsEvent')

        expect(beforeTools).toEqual(
          new BeforeToolsEvent({
            agent: agent,
            message: new Message({
              role: 'assistant',
              content: [new ToolUseBlock({ name: 'testTool', toolUseId: 'tool-1', input: {} })],
              trackingId: anyTrackingId,
            }),
            invocationState: {},
          })
        )

        expect(afterTools).toBeDefined()
        expect(afterTools?.type).toBe('afterToolsEvent')
        expect(afterTools?.message).toEqual({
          type: 'message',
          role: 'user',
          trackingId: anyTrackingId,
          content: [
            {
              type: 'toolResultBlock',
              toolUseId: 'tool-1',
              status: 'success',
              content: [{ type: 'textBlock', text: 'Success' }],
            },
          ],
        })
        expect(afterTools).toHaveProperty('agent', agent)
      })
    })

    describe('error handling', () => {
      it('throws MaxTokensError when model hits token limit', async () => {
        const model = new MockMessageModel().addTurn(
          { type: 'textBlock', text: 'Partial...' },
          { stopReason: 'maxTokens' }
        )
        const agent = new Agent({ model })

        await expect(async () => {
          await collectGenerator(agent.stream('Test'))
        }).rejects.toThrow(MaxTokensError)
      })
    })

    describe('hook error cleanup', () => {
      it('fires AfterInvocationEvent when consumer breaks from stream and allows reinvocation', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('ok')],
            })
        )

        const agent = new Agent({ model, tools: [tool], printer: false })

        const afterInvocationCallback = vi.fn()
        agent.addHook(AfterInvocationEvent, afterInvocationCallback)

        for await (const event of agent.stream('Test')) {
          if (event.type === 'beforeToolsEvent') {
            break
          }
        }

        expect(afterInvocationCallback).toHaveBeenCalledOnce()

        const result = await agent.invoke('Test again')
        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.content[0]).toEqual(new TextBlock('Done'))
      })
    })
  })

  describe('invoke', () => {
    describe('basic invocation', () => {
      it('returns Promise<AgentResult>', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        const result = agent.invoke('Test prompt')

        expect(result).toBeInstanceOf(Promise)
        const awaited = await result
        expect(awaited).toHaveProperty('stopReason')
        expect(awaited).toHaveProperty('lastMessage')
      })

      it('returns correct stopReason and lastMessage', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response text' })
        const agent = new Agent({ model })

        const result = await agent.invoke('Test prompt')

        expect(result).toEqual(
          expectAgentResult({
            stopReason: 'endTurn',
            messageText: 'Response text',
            cycleCount: 1,
            traceCount: 1,
          })
        )
      })

      it('consumes stream events internally', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        const result = await agent.invoke('Test')

        expect(result).toEqual(
          expect.objectContaining({
            stopReason: 'endTurn',
            lastMessage: expect.objectContaining({
              type: 'message',
              role: 'assistant',
              content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: 'Hello' })]),
            }),
            metrics: expectLoopMetrics({ cycleCount: 1 }),
          })
        )
      })
    })

    describe('with tool use', () => {
      it('executes tools and returns final result', async () => {
        const model = new MockMessageModel()
          .addTurn(
            { type: 'toolUseBlock', name: 'calc', toolUseId: 'tool-1', input: { a: 1, b: 2 } },
            {
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            }
          )
          .addTurn(
            { type: 'textBlock', text: 'The answer is 3' },
            {
              usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
            }
          )

        const tool = createMockTool(
          'calc',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('3')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const result = await agent.invoke('What is 1 + 2?')

        expect(result).toEqual(
          expectAgentResult({
            stopReason: 'endTurn',
            messageText: 'The answer is 3',
            cycleCount: 2,
            toolNames: ['calc'],
            traceCount: 2,
            usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
          })
        )
        // Verify detailed trace children structure
        expect(result.traces?.[0]?.children).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'stream_messages' }),
            expect.objectContaining({ name: 'Tool: calc' }),
          ])
        )
        expect(result.traces?.[1]?.children).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'stream_messages' })])
        )
      })

      it('stores cycleId in trace metadata', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'calc',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('result')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const result = await agent.invoke('Test')

        expect(result.traces).toEqual([
          expect.objectContaining({
            name: 'Cycle 1',
            metadata: expect.objectContaining({ cycleId: 'cycle-1' }),
          }),
          expect.objectContaining({
            name: 'Cycle 2',
            metadata: expect.objectContaining({ cycleId: 'cycle-2' }),
          }),
        ])
      })

      it('stores tool metadata in trace children', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-abc123', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-abc123',
              status: 'success' as const,
              content: [new TextBlock('result')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const result = await agent.invoke('Test')

        expect(result.traces).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'Cycle 1',
              children: expect.arrayContaining([
                expect.objectContaining({
                  name: 'Tool: testTool',
                  metadata: expect.objectContaining({
                    toolUseId: 'tool-abc123',
                    toolName: 'testTool',
                  }),
                }),
              ]),
            }),
          ])
        )
      })
    })

    describe('error handling', () => {
      it('propagates maxTokens error', async () => {
        const model = new MockMessageModel().addTurn(
          { type: 'textBlock', text: 'Partial' },
          { stopReason: 'maxTokens' }
        )
        const agent = new Agent({ model })

        await expect(agent.invoke('Test')).rejects.toThrow(MaxTokensError)
      })
    })

    describe('metrics getter', () => {
      it('exposes accumulated metrics on the agent instance', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model })

        expect(agent.metrics.cycleCount).toBe(0)

        await agent.invoke('Test')

        expect(agent.metrics.cycleCount).toBe(1)
      })

      it('includes the completed cycle duration in the returned result metrics', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(0)

        try {
          const model = new MockMessageModel().addTurn(
            { type: 'toolUseBlock', name: 'slowTool', toolUseId: 'tool-1', input: {} },
            { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
          )

          const tool = createMockTool(
            'slowTool',
            (context) =>
              new ToolResultBlock({
                toolUseId: context.toolUse.toolUseId,
                status: 'success' as const,
                content: [new TextBlock('Done')],
              })
          )

          const agent = new Agent({ model, tools: [tool] })
          agent.addHook(BeforeToolsEvent, () => {
            vi.setSystemTime(60)
          })
          agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
            event.endTurn = true
          })

          const result = await agent.invoke('Test')

          expect(result.stopReason).toBe('endTurn')
          expect(result.metrics).toMatchObject({
            cycleCount: 1,
            totalDuration: 60,
            averageCycleTime: 60,
            latestAgentInvocation: { cycles: [{ duration: 60 }] },
          })
        } finally {
          vi.useRealTimers()
        }
      })

      it('includes the cycle duration when the model ends the turn without tools', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(0)

        try {
          const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
          const agent = new Agent({ model })
          agent.addHook(BeforeModelCallEvent, () => {
            vi.setSystemTime(60)
          })

          const result = await agent.invoke('Test')

          expect(result.metrics).toMatchObject({
            cycleCount: 1,
            totalDuration: 60,
            averageCycleTime: 60,
            latestAgentInvocation: { cycles: [{ duration: 60 }] },
          })
        } finally {
          vi.useRealTimers()
        }
      })
    })

    describe('metrics on errors', () => {
      it('tracks cycle count when maxTokens error occurs', async () => {
        const model = new MockMessageModel()
          .addTurn(
            { type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} },
            {
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            }
          )
          .addTurn(
            { type: 'textBlock', text: 'Partial' },
            {
              stopReason: 'maxTokens',
              usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
            }
          )

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('Done')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const meter = (agent as any)._meter
        await expect(agent.invoke('Test')).rejects.toThrow(MaxTokensError)

        expect(meter.metrics.cycleCount).toBe(2)
        // Only the first turn's usage is accumulated; the second turn throws
        // MaxTokensError inside streamAggregated before metadata reaches updateCycle
        expect(meter.metrics.accumulatedUsage).toStrictEqual({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        })
        expect(meter.metrics.accumulatedMetrics).toStrictEqual({
          latencyMs: expect.any(Number),
        })
        expect(meter.metrics.toolMetrics).toStrictEqual({
          testTool: {
            callCount: 1,
            successCount: 1,
            errorCount: 0,
            totalTime: expect.any(Number),
          },
        })
      })

      it('collects local traces for completed cycles when error occurs mid-run', async () => {
        const model = new MockMessageModel()
          .addTurn(
            { type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} },
            {
              usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            }
          )
          .addTurn(
            { type: 'textBlock', text: 'Partial' },
            {
              stopReason: 'maxTokens',
              usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
            }
          )

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('Done')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        const tracer = (agent as any)._tracer
        await expect(agent.invoke('Test')).rejects.toThrow(MaxTokensError)

        // Cycle 1 completed (tool use), cycle 2 errored (maxTokens)
        expect(tracer.localTraces).toEqual([
          expect.objectContaining({
            name: 'Cycle 1',
            children: [
              expect.objectContaining({ name: 'stream_messages' }),
              expect.objectContaining({ name: 'Tool: testTool' }),
            ],
          }),
          expect.objectContaining({
            name: 'Cycle 2',
            children: [expect.objectContaining({ name: 'stream_messages' })],
          }),
        ])
      })

      it('tracks metrics when a hook throws an error', async () => {
        const model = new MockMessageModel()
          .addTurn(
            { type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} },
            {
              usage: { inputTokens: 60, outputTokens: 25, totalTokens: 85 },
            }
          )
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('Result')],
            })
        )

        const agent = new Agent({ model, tools: [tool] })

        agent.addHook(BeforeToolsEvent, () => {
          throw new Error('Hook failure')
        })

        const meter = (agent as any)._meter
        await expect(agent.invoke('Test')).rejects.toThrow('Hook failure')

        // The hook throws after the model returns but before tools execute,
        // so the first cycle's model usage is recorded but no tool metrics exist
        expect(meter.metrics.cycleCount).toBe(1)
        expect(meter.metrics.accumulatedUsage).toStrictEqual({
          inputTokens: 60,
          outputTokens: 25,
          totalTokens: 85,
        })
        expect(meter.metrics.accumulatedMetrics).toStrictEqual({
          latencyMs: expect.any(Number),
        })
        expect(meter.metrics.toolMetrics).toStrictEqual({})
      })
    })

    describe('hook error cleanup', () => {
      it('fires AfterInvocationEvent when a mid-stream hook throws', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('ok')],
            })
        )

        const agent = new Agent({ model, tools: [tool], printer: false })

        agent.addHook(AfterToolCallEvent, () => {
          throw new Error('hook error')
        })

        const afterInvocationCallback = vi.fn()
        agent.addHook(AfterInvocationEvent, afterInvocationCallback)

        await expect(agent.invoke('Test')).rejects.toThrow('hook error')
        expect(afterInvocationCallback).toHaveBeenCalledOnce()
      })

      it('fires AfterToolsEvent when a mid-stream hook throws', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('ok')],
            })
        )

        const agent = new Agent({ model, tools: [tool], printer: false })

        agent.addHook(AfterToolCallEvent, () => {
          throw new Error('hook error')
        })

        const afterToolsCallback = vi.fn()
        agent.addHook(AfterToolsEvent, afterToolsCallback)

        await expect(agent.invoke('Test')).rejects.toThrow('hook error')
        expect(afterToolsCallback).toHaveBeenCalledOnce()
      })

      it('does not fire AfterInvocationEvent when BeforeInvocationEvent hook throws', async () => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
        const agent = new Agent({ model, printer: false })

        agent.addHook(BeforeInvocationEvent, () => {
          throw new Error('before hook error')
        })

        const afterInvocationCallback = vi.fn()
        agent.addHook(AfterInvocationEvent, afterInvocationCallback)

        await expect(agent.invoke('Test')).rejects.toThrow('before hook error')
        expect(afterInvocationCallback).not.toHaveBeenCalled()
      })

      it('does not fire AfterToolsEvent when BeforeToolsEvent hook throws', async () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'Done' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success' as const,
              content: [new TextBlock('ok')],
            })
        )

        const agent = new Agent({ model, tools: [tool], printer: false })

        agent.addHook(BeforeToolsEvent, () => {
          throw new Error('before tools hook error')
        })

        const afterToolsCallback = vi.fn()
        agent.addHook(AfterToolsEvent, afterToolsCallback)

        await expect(agent.invoke('Test')).rejects.toThrow('before tools hook error')
        expect(afterToolsCallback).not.toHaveBeenCalled()
      })
    })
  })

  describe('API consistency', () => {
    it('invoke() and stream() produce same final result', async () => {
      const model1 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Consistent response' })
      const model2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Consistent response' })

      const agent1 = new Agent({ model: model1 })
      const agent2 = new Agent({ model: model2 })

      const invokeResult = await agent1.invoke('Test')
      const { result: streamResult } = await collectGenerator(agent2.stream('Test'))

      expect(invokeResult.stopReason).toBe(streamResult.stopReason)
      expect(invokeResult.lastMessage.content).toEqual(streamResult.lastMessage.content)
    })

    it('both methods produce same result with tool use', async () => {
      const createToolAndModels = () => {
        const model = new MockMessageModel()
          .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'id', input: {} })
          .addTurn({ type: 'textBlock', text: 'Final' })

        const tool = createMockTool(
          'testTool',
          () =>
            new ToolResultBlock({
              toolUseId: 'id',
              status: 'success' as const,
              content: [new TextBlock('Tool ran')],
            })
        )

        return { model, tool }
      }

      const { model: model1, tool: tool1 } = createToolAndModels()
      const { model: model2, tool: tool2 } = createToolAndModels()

      const agent1 = new Agent({ model: model1, tools: [tool1] })
      const agent2 = new Agent({ model: model2, tools: [tool2] })

      const invokeResult = await agent1.invoke('Use tool')
      const { result: streamResult } = await collectGenerator(agent2.stream('Use tool'))

      expect(invokeResult).toEqual(
        expect.objectContaining({
          stopReason: streamResult.stopReason,
          // The two runs are independent agents, so message ids differ; compare role + content only.
          lastMessage: expect.objectContaining({
            role: streamResult.lastMessage.role,
            content: streamResult.lastMessage.content,
          }),
          traces: streamResult.traces?.map((t) =>
            expect.objectContaining({
              name: t.name,
              children: expect.arrayContaining(
                Array(t.children.length).fill(expect.objectContaining({ name: expect.any(String) }))
              ),
            })
          ),
        })
      )
    })
  })

  describe('messages', () => {
    it('returns array of messages', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      expect(agent.messages).toEqual([])
    })

    it('reflects conversation history after invoke', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model })

      await agent.invoke('Hello')

      expect(agent.messages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [{ type: 'textBlock', text: 'Hello' }],
        }),
        expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'textBlock', text: 'Response' }],
        }),
      ])
    })
  })

  describe('printer configuration', () => {
    it('validates output when printer is enabled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello world' })

      // Capture output
      const outputs: string[] = []
      const mockAppender = (text: string) => outputs.push(text)

      // Create agent with custom printer for testing
      const agent = new Agent({ model, printer: false })
      ;(agent as any)._printer = new AgentPrinter(mockAppender)

      await collectGenerator(agent.stream('Test'))

      // Validate that text was output
      const allOutput = outputs.join('')
      expect(allOutput).toContain('Hello world')
    })

    it('does not create printer when printer is false', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      expect(agent).toBeDefined()
      expect((agent as any)._printer).toBeUndefined()
    })

    it('defaults to printer=true when not specified', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      expect(agent).toBeDefined()
      expect((agent as any)._printer).toBeDefined()
    })

    it('agent works correctly with printer disabled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const { result } = await collectGenerator(agent.stream('Test'))

      expect(result).toBeDefined()
      expect(result.lastMessage.content).toEqual([{ type: 'textBlock', text: 'Hello' }])
    })
  })

  describe('concurrency guards', () => {
    it('prevents parallel invocations', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model })

      // Test parallel invoke() calls
      const invokePromise1 = agent.invoke('First')
      const invokePromise2 = agent.invoke('Second')

      await expect(invokePromise2).rejects.toThrow(ConcurrentInvocationError)
      await expect(invokePromise1).resolves.toBeDefined()
    })

    it('allows sequential invocations after lock is released', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First response' })
        .addTurn({ type: 'textBlock', text: 'Second response' })
      const agent = new Agent({ model })

      const result1 = await agent.invoke('First')
      expect(result1.lastMessage.content).toEqual([{ type: 'textBlock', text: 'First response' }])

      const result2 = await agent.invoke('Second')
      expect(result2.lastMessage.content).toEqual([{ type: 'textBlock', text: 'Second response' }])
    })

    it('releases lock after errors and abandoned streams', async () => {
      // Test error case
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'Partial' }, { stopReason: 'maxTokens' })
        .addTurn({ type: 'textBlock', text: 'Success' })
      const agent = new Agent({ model })

      await expect(agent.invoke('First')).rejects.toThrow(MaxTokensError)

      const result = await agent.invoke('Second')
      expect(result.lastMessage.content).toEqual([{ type: 'textBlock', text: 'Success' }])
    })
  })

  describe('nested tool arrays', () => {
    describe('flattens nested arrays at any depth', () => {
      const tool1 = createRandomTool()
      const tool2 = createRandomTool()
      const tool3 = createRandomTool()

      it.for([
        ['flat array', [tool1, tool2, tool3], [tool1, tool2, tool3]],
        ['single tool', [tool1], [tool1]],
        ['empty array', [], []],
        ['single level nesting', [[tool1, tool2], tool3], [tool1, tool2, tool3]],
        ['empty nested arrays', [[], tool1, []], [tool1]],
        ['deeply nested', [[[tool1]], [tool2], tool3], [tool1, tool2, tool3]],
        ['mixed nesting', [[tool1, [tool2]], tool3], [tool1, tool2, tool3]],
        ['very deep nesting', [[[[tool1]]]], [tool1]],
      ])('%i', ([, input, expected]) => {
        const agent = new Agent({ tools: input as ToolList })
        expect(agent.tools).toEqual(expected)
      })
    })

    it('accepts undefined tools', () => {
      const agent = new Agent({})

      expect(agent.tools).toEqual([])
    })

    it('catches duplicate tool names across nested arrays', () => {
      const tool1 = createRandomTool('duplicate')
      const tool2 = createRandomTool('duplicate')

      expect(() => new Agent({ tools: [[tool1], [tool2]] })).toThrow("Tool with name 'duplicate' already registered")
    })
  })

  describe('systemPrompt configuration', () => {
    describe('when provided as string SystemPromptData', () => {
      it('accepts and stores string system prompt', () => {
        const agent = new Agent({ systemPrompt: 'You are a helpful assistant' })
        expect(agent).toBeDefined()
      })
    })

    describe('when provided as array SystemPromptData', () => {
      it('converts TextBlockData to TextBlock', () => {
        const agent = new Agent({ systemPrompt: [{ text: 'System prompt text' }] })
        expect(agent).toBeDefined()
      })

      it('converts mixed block data types', () => {
        const agent = new Agent({
          systemPrompt: [{ text: 'First block' }, { cachePoint: { cacheType: 'default' } }, { text: 'Second block' }],
        })
        expect(agent).toBeDefined()
      })
    })

    describe('when provided as SystemPrompt (class instances)', () => {
      it('accepts array of class instances', () => {
        const systemPrompt = [new TextBlock('System prompt'), new CachePointBlock({ cacheType: 'default' })]
        const agent = new Agent({ systemPrompt })
        expect(agent).toBeDefined()
      })
    })

    describe('when modifying systemPrompt', () => {
      it('allows systemPrompt to be set after initialization', () => {
        const agent = new Agent({ systemPrompt: 'Initial prompt' })

        agent.systemPrompt = 'Updated prompt'

        expect(agent.systemPrompt).toEqual('Updated prompt')
      })

      it('allows systemPrompt to be changed between turns', async () => {
        const firstModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'First response' })

        const streamSpy = vi.spyOn(firstModel, 'stream')

        const agent = new Agent({ model: firstModel, systemPrompt: [new TextBlock('You are a helpful assistant')] })

        // First invocation with initial system prompt
        await agent.invoke('First prompt')
        expect(agent.systemPrompt).toEqual([new TextBlock('You are a helpful assistant')])

        // Should have been called with the given promp
        expect(streamSpy).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({
            systemPrompt: [new TextBlock('You are a helpful assistant')],
            toolSpecs: [],
          })
        )

        // Change system prompt and model
        agent.systemPrompt = 'You are a coding expert'

        // Second invocation should use new system prompt
        streamSpy.mockReset()
        await agent.invoke('Second prompt')
        expect(agent.systemPrompt).toEqual('You are a coding expert')
        expect(streamSpy).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({
            systemPrompt: 'You are a coding expert',
            toolSpecs: [],
          })
        )
      })
    })
  })

  describe('model property', () => {
    describe('when accessing the model field', () => {
      it('returns the configured model instance', () => {
        const model = new MockMessageModel()
        const agent = new Agent({ model })

        expect(agent.model).toBe(model)
      })

      it('returns default BedrockModel when no model provided', () => {
        const agent = new Agent()

        expect(agent.model).toBeDefined()
        expect(agent.model.constructor.name).toBe('BedrockModel')
      })
    })

    describe('when modifying the model field', () => {
      it('updates the model instance', () => {
        const initialModel = new MockMessageModel()
        const newModel = new MockMessageModel()
        const agent = new Agent({ model: initialModel })

        agent.model = newModel

        expect(agent.model).toBe(newModel)
        expect(agent.model).not.toBe(initialModel)
      })

      it('allows model change to persist across invocations', async () => {
        const firstModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'First response' })
        const secondModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Second response' })
        const agent = new Agent({ model: firstModel })

        // First invocation with initial model
        const firstResult = await agent.invoke('First prompt')
        expect(firstResult.lastMessage?.content[0]).toEqual(new TextBlock('First response'))

        // Change model
        agent.model = secondModel

        // Second invocation should use new model
        const secondResult = await agent.invoke('Second prompt')
        expect(secondResult.lastMessage?.content[0]).toEqual(new TextBlock('Second response'))
      })

      it('successfully switches between different model providers', async () => {
        const bedrockModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Bedrock response' })
        const openaiModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'OpenAI response' })
        const agent = new Agent({ model: bedrockModel })

        // First invocation
        const firstResult = await agent.invoke('First prompt')
        expect(firstResult.lastMessage?.content[0]).toEqual(new TextBlock('Bedrock response'))

        // Switch to different provider
        agent.model = openaiModel

        // Second invocation with new provider
        const secondResult = await agent.invoke('Second prompt')
        expect(secondResult.lastMessage?.content[0]).toEqual(new TextBlock('OpenAI response'))
      })
    })
  })

  describe('durable message id', () => {
    it('assigns a durable tracking id to every recorded message', async () => {
      const model = new MockMessageModel().addTurn(new TextBlock('Response'))
      const agent = new Agent({ model })

      await agent.invoke('Hello')

      expect(agent.messages).toHaveLength(2)
      for (const message of agent.messages) {
        expect(typeof message.trackingId).toBe('string')
      }
      // Ids are unique per message.
      expect(agent.messages[0]!.trackingId).not.toBe(agent.messages[1]!.trackingId)
    })

    it('preserves a caller-supplied id on input messages', async () => {
      const model = new MockMessageModel().addTurn(new TextBlock('Response'))
      const agent = new Agent({
        model,
        messages: [{ role: 'user', content: [{ text: 'Earlier' }], trackingId: 'caller-supplied' }],
      })

      await agent.invoke('Hello')

      expect(agent.messages[0]!.trackingId).toBe('caller-supplied')
    })
  })

  describe('multimodal input', () => {
    describe('with string input', () => {
      it('creates user message with single TextBlock', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        await agent.invoke('Hello')

        expect(agent.messages).toHaveLength(2)
        expect(agent.messages[0]).toEqual(
          new Message({
            role: 'user',
            content: [new TextBlock('Hello')],
            trackingId: anyTrackingId,
          })
        )
      })
    })

    describe('with ContentBlock[] input', () => {
      it('creates single user message with single TextBlock', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        await agent.invoke([new TextBlock('Hello')])

        expect(agent.messages).toHaveLength(2)
        expect(agent.messages[0]).toEqual(
          new Message({
            role: 'user',
            content: [new TextBlock('Hello')],
            trackingId: anyTrackingId,
          })
        )
      })

      it('creates single user message with multiple blocks', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        const contentBlocks = [new TextBlock('Analyze this'), new TextBlock('and this')]

        await agent.invoke(contentBlocks)

        expect(agent.messages).toHaveLength(2)
        expect(agent.messages[0]).toEqual(
          new Message({
            role: 'user',
            content: contentBlocks,
            trackingId: anyTrackingId,
          })
        )
      })

      it('supports all ContentBlock types', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        const contentBlocks = [
          new TextBlock('Text content'),
          new ToolUseBlock({ name: 'tool1', toolUseId: 'id-1', input: { key: 'value' } }),
          new ToolResultBlock({
            toolUseId: 'id-1',
            status: 'success',
            content: [new TextBlock('Result')],
          }),
          new ReasoningBlock({ text: 'My reasoning' }),
          new CachePointBlock({ cacheType: 'default' }),
          new GuardContentBlock({ text: { text: 'Guard content', qualifiers: ['grounding_source'] } }),
          new AudioBlock({
            format: 'mp3',
            source: { bytes: new Uint8Array([1, 2, 3]) },
          }),
          new ImageBlock({
            format: 'png',
            source: { url: 'https://example.com/image.png' },
          }),
          new VideoBlock({
            format: 'mp4',
            source: { location: { type: 's3', uri: 's3://bucket/video.mp4' } },
          }),
          new DocumentBlock({
            format: 'pdf',
            name: 'doc.pdf',
            source: { bytes: new Uint8Array([1, 2, 3]) },
          }),
        ]

        await agent.invoke(contentBlocks)

        expect(agent.messages).toHaveLength(2)
        expect(agent.messages[0]).toEqual(
          new Message({
            role: 'user',
            content: contentBlocks,
            trackingId: anyTrackingId,
          })
        )
      })

      it('handles empty ContentBlock array', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        await agent.invoke([])

        expect(agent.messages).toHaveLength(1) // Only response message added
      })

      it('accepts ContentBlockData[] and converts to ContentBlock[]', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        await agent.invoke([
          { text: 'Hello from data format' },
          {
            toolUse: {
              name: 'testTool',
              toolUseId: 'id-1',
              input: { key: 'value' },
            },
          },
          {
            toolResult: {
              toolUseId: 'id-1',
              status: 'success' as const,
              content: [{ text: 'Tool result' }, { json: { result: 42 } }],
            },
          },
          { reasoning: { text: 'My reasoning' } },
          { cachePoint: { cacheType: 'default' as const } },
          { guardContent: { text: { text: 'Guard text', qualifiers: ['query' as const] } } },
          {
            audio: {
              format: 'mp3' as const,
              source: { bytes: new Uint8Array([1, 2, 3]) },
            },
          },
          {
            image: {
              format: 'png' as const,
              source: { url: 'https://example.com/image.png' },
            },
          },
          {
            video: {
              format: 'mp4' as const,
              source: { location: { type: 's3' as const, uri: 's3://bucket/video.mp4' } },
            },
          },
          {
            document: {
              format: 'pdf' as const,
              name: 'doc.pdf',
              source: { bytes: new Uint8Array([1, 2, 3]) },
            },
          },
        ])

        expect(agent.messages).toHaveLength(2)
        const userMessage = agent.messages[0]!
        expect(userMessage.role).toBe('user')
        expect(userMessage.content).toHaveLength(10)
        expect(userMessage.content[0]).toEqual(new TextBlock('Hello from data format'))
        expect(userMessage.content[1]).toEqual(
          new ToolUseBlock({ name: 'testTool', toolUseId: 'id-1', input: { key: 'value' } })
        )
      })
    })

    describe('with Message[] input', () => {
      it('appends single message to conversation', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        const userMessage = new Message({
          role: 'user',
          content: [new TextBlock('Hello')],
        })

        await agent.invoke([userMessage])

        expect(agent.messages).toHaveLength(2)
        expect(agent.messages[0]).toEqual(userMessage)
      })

      it('appends multiple messages in order', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        const messages = [
          new Message({
            role: 'user',
            content: [new TextBlock('First message')],
          }),
          new Message({
            role: 'assistant',
            content: [new TextBlock('Second message')],
          }),
          new Message({
            role: 'user',
            content: [new TextBlock('Third message')],
          }),
        ]

        await agent.invoke(messages)

        expect(agent.messages).toHaveLength(4) // 3 input + 1 response
        expect(agent.messages[0]).toEqual(messages[0])
        expect(agent.messages[1]).toEqual(messages[1])
        expect(agent.messages[2]).toEqual(messages[2])
      })

      it('handles empty Message array', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        await agent.invoke([])

        expect(agent.messages).toHaveLength(1) // Only response message added
      })

      it('accepts MessageData[] and converts to Message[]', async () => {
        const model = new MockMessageModel().addTurn(new TextBlock('Response'))
        const agent = new Agent({ model })

        const messageDataArray = [
          {
            role: 'user' as const,
            content: [{ text: 'First message' }],
          },
          {
            role: 'assistant' as const,
            content: [{ text: 'Second message' }],
          },
        ]

        await agent.invoke(messageDataArray)

        expect(agent.messages).toHaveLength(3) // 2 input + 1 response
        expect(agent.messages[0]).toEqual(
          new Message({
            role: 'user',
            content: [new TextBlock('First message')],
            trackingId: anyTrackingId,
          })
        )
        expect(agent.messages[1]).toEqual(
          new Message({
            role: 'assistant',
            content: [new TextBlock('Second message')],
            trackingId: anyTrackingId,
          })
        )
      })
    })
  })

  describe('model initialization', () => {
    describe('when model is a string', () => {
      it('creates BedrockModel with specified modelId', () => {
        const agent = new Agent({ model: 'anthropic.claude-3-5-sonnet-20240620-v1:0' })

        expect(agent.model).toBeDefined()
        expect(agent.model.constructor.name).toBe('BedrockModel')
        expect(agent.model.getConfig().modelId).toBe('anthropic.claude-3-5-sonnet-20240620-v1:0')
      })

      it('creates BedrockModel with custom model ID', () => {
        const customModelId = 'custom.model.id'
        const agent = new Agent({ model: customModelId })

        expect(agent.model.getConfig().modelId).toBe(customModelId)
      })
    })

    describe('when model is explicit BedrockModel', () => {
      it('uses provided BedrockModel instance', () => {
        const explicitModel = new BedrockModel({ modelId: 'explicit-model-id' })
        const agent = new Agent({ model: explicitModel })

        expect(agent.model).toBe(explicitModel)
        expect(agent.model.getConfig().modelId).toBe('explicit-model-id')
      })
    })

    describe('when no model is provided', () => {
      it('creates default BedrockModel', () => {
        const agent = new Agent()

        expect(agent.model).toBeDefined()
        expect(agent.model.constructor.name).toBe('BedrockModel')
      })
    })

    describe('behavior parity', () => {
      it('string model behaves identically to explicit BedrockModel with same modelId', () => {
        const modelId = 'anthropic.claude-3-5-sonnet-20240620-v1:0'

        // Create agent with string model ID
        const agentWithString = new Agent({ model: modelId })

        // Create agent with explicit BedrockModel
        const explicitModel = new BedrockModel({ modelId })
        const agentWithExplicit = new Agent({ model: explicitModel })

        // Both should have same modelId
        expect(agentWithString.model.getConfig().modelId).toBe(agentWithExplicit.model.getConfig().modelId)
        expect(agentWithString.model.getConfig().modelId).toBe(modelId)
      })
    })
  })

  describe('structured output', () => {
    it('returns structured output when schema provided and tool used', async () => {
      const schema = z.object({ name: z.string(), age: z.number() })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { name: 'John', age: 30 },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      const result = await agent.invoke('Test')

      expect(result.structuredOutput).toEqual({ name: 'John', age: 30 })
      expect(model.callCount).toBe(1)
    })

    it('forces structured output tool when model does not use it', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First response' })
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'tool-1', input: { value: 42 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      const result = await agent.invoke('Test')

      expect(result.structuredOutput).toEqual({ value: 42 })
    })

    it('does not send assistant-ended conversation when forcing structured output retry', async () => {
      // Regression for https://github.com/strands-agents/sdk-typescript/issues/1039
      // When the model responds with plain text instead of calling the structured output tool,
      // the forced-retry model call must not see a conversation ending with an assistant message.
      // Bedrock/Anthropic-family models reject assistant message prefill.
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'Plain text, no tool call' })
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'tool-1', input: { value: 42 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      // Snapshot the role sequence at each model call, since `messages` is passed by reference
      // and mutates during the agent loop.
      const roleSnapshots: string[][] = []
      const originalStream = model.stream.bind(model)
      vi.spyOn(model, 'stream').mockImplementation((messages, options) => {
        roleSnapshots.push(messages.map((m) => m.role))
        return originalStream(messages, options)
      })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      await agent.invoke('Test')

      expect(roleSnapshots.length).toBeGreaterThanOrEqual(2)

      // The forced-retry (second) call must not see a conversation ending with an assistant turn.
      const secondCallRoles = roleSnapshots[1]!
      expect(secondCallRoles[secondCallRoles.length - 1]).toBe('user')
    })

    it('throws StructuredOutputError when model refuses to use tool after forcing', async () => {
      const schema = z.object({ value: z.number() })

      // Model returns text twice - once normally, once when forced
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      await expect(agent.invoke('Test')).rejects.toThrow(StructuredOutputError)
    })

    it('throws MaxTokensError when maxTokens reached before structured output', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'Partial...' },
        { stopReason: 'maxTokens' }
      )

      const agent = new Agent({ model, structuredOutputSchema: schema })

      await expect(agent.invoke('Test')).rejects.toThrow(MaxTokensError)
    })

    it('retries with validation feedback when structured output tool returns error', async () => {
      const schema = z.object({ name: z.string(), age: z.number() })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { name: 'John', age: 'invalid' },
        })
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-2',
          input: { name: 'John', age: 30 },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      const result = await agent.invoke('Test')

      expect(result.structuredOutput).toEqual({ name: 'John', age: 30 })
    })

    it('works without structured output schema', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })

      const agent = new Agent({ model })

      const result = await agent.invoke('Test')

      expect(result.structuredOutput).toBeUndefined()
    })

    it('cleans up structured output tool after invocation', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'strands_structured_output', toolUseId: 'tool-1', input: { value: 42 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      await agent.invoke('Test')

      const toolNames = agent.tools.map((t) => t.name)
      expect(toolNames).not.toContain('strands_structured_output')
    })

    it('cleans up structured output tool even when error occurs', async () => {
      const schema = z.object({ value: z.number() })

      const model = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'Partial...' },
        { stopReason: 'maxTokens' }
      )

      const agent = new Agent({ model, structuredOutputSchema: schema })

      await expect(agent.invoke('Test')).rejects.toThrow()

      const toolNames = agent.tools.map((t) => t.name)
      expect(toolNames).not.toContain('strands_structured_output')
    })

    it('validates nested objects in structured output', async () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
      })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { user: { name: 'Alice', age: 25 } },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      const result = await agent.invoke('Test')

      expect(result.structuredOutput).toEqual({ user: { name: 'Alice', age: 25 } })
    })

    it('validates arrays in structured output', async () => {
      const schema = z.object({
        items: z.array(z.string()),
      })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { items: ['a', 'b', 'c'] },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })

      const result = await agent.invoke('Test')

      expect(result.structuredOutput).toEqual({ items: ['a', 'b', 'c'] })
    })

    it('uses per-invocation override schema and restores constructor schema on next call', async () => {
      const constructorSchema = z.object({ name: z.string() })
      const overrideSchema = z.object({ value: z.number() })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { value: 99 },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-2',
          input: { name: 'Bob' },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: constructorSchema })

      const first = await agent.invoke('First', { structuredOutputSchema: overrideSchema })
      expect(first.structuredOutput).toEqual({ value: 99 })

      const second = await agent.invoke('Second')
      expect(second.structuredOutput).toEqual({ name: 'Bob' })
    })

    it('skips structured output extraction when AfterToolsEvent.endTurn halts the loop', async () => {
      const schema = z.object({ name: z.string() })

      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'tool-1',
          input: { name: 'John' },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, structuredOutputSchema: schema })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = true
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(result.structuredOutput).toBeUndefined()
      expect(model.callCount).toBe(1)
    })
  })
})

describe('Agent._redactLastMessage', () => {
  const redactMessage = '[REDACTED]'

  it('redacts last user message with only text blocks', () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
    const agent = new Agent({ model })

    // Add a user message
    agent['messages'].push(
      new Message({
        role: 'user',
        content: [new TextBlock('sensitive content')],
      })
    )

    agent['_redactLastMessage'](redactMessage)

    const lastMessage = agent['messages'][agent['messages'].length - 1]!
    expect(lastMessage.role).toBe('user')
    expect(lastMessage.content).toHaveLength(1)
    expect(lastMessage.content[0]!.type).toBe('textBlock')
    expect((lastMessage.content[0] as TextBlock).text).toBe(redactMessage)
  })

  it('preserves the durable tracking id when redacting', () => {
    // Redaction rebuilds the message as a new Message that stays in history, so its tracking id
    // must survive.
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
    const agent = new Agent({ model })

    agent['messages'].push(
      new Message({
        role: 'user',
        content: [new TextBlock('sensitive content')],
        trackingId: 'durable-1',
      })
    )

    agent['_redactLastMessage'](redactMessage)

    expect(agent['messages'][agent['messages'].length - 1]!.trackingId).toBe('durable-1')
  })

  it('preserves tool result blocks with redacted content', () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
    const agent = new Agent({ model })

    // Add a user message with tool result and text blocks
    agent['messages'].push(
      new Message({
        role: 'user',
        content: [
          new TextBlock('some text'),
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('tool result content')],
          }),
          new TextBlock('more text'),
          new ToolResultBlock({
            toolUseId: 'tool-2',
            status: 'error',
            content: [new TextBlock('error content')],
          }),
        ],
      })
    )

    agent['_redactLastMessage'](redactMessage)

    const lastMessage = agent['messages'][agent['messages'].length - 1]!
    expect(lastMessage.role).toBe('user')
    expect(lastMessage.content).toHaveLength(2)

    // Only tool result blocks should remain
    expect(lastMessage.content[0]!.type).toBe('toolResultBlock')
    expect(lastMessage.content[1]!.type).toBe('toolResultBlock')

    // Tool result blocks should have redacted content but preserve structure
    const toolResult1 = lastMessage.content[0] as ToolResultBlock
    expect(toolResult1.toolUseId).toBe('tool-1')
    expect(toolResult1.status).toBe('success')
    expect(toolResult1.content).toHaveLength(1)
    expect((toolResult1.content[0] as TextBlock).text).toBe(redactMessage)

    const toolResult2 = lastMessage.content[1] as ToolResultBlock
    expect(toolResult2.toolUseId).toBe('tool-2')
    expect(toolResult2.status).toBe('error')
    expect(toolResult2.content).toHaveLength(1)
    expect((toolResult2.content[0] as TextBlock).text).toBe(redactMessage)
  })

  it('does not redact when last message is not from user', () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
    const agent = new Agent({ model })

    // Add an assistant message
    const assistantMessage = new Message({
      role: 'assistant',
      content: [new TextBlock('assistant response')],
    })
    agent['messages'].push(assistantMessage)

    const originalContent = assistantMessage.content
    agent['_redactLastMessage'](redactMessage)

    const lastMessage = agent['messages'][agent['messages'].length - 1]!
    expect(lastMessage.role).toBe('assistant')
    expect(lastMessage.content).toBe(originalContent)
  })

  it('handles empty messages array gracefully', () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
    const agent = new Agent({ model })

    expect(() => agent['_redactLastMessage'](redactMessage)).not.toThrow()
    expect(agent['messages']).toHaveLength(0)
  })
})

describe('_estimateInputTokens', () => {
  function captureProjectedTokens(agent: Agent): Promise<number | undefined> {
    return new Promise((resolve) => {
      agent.addHook(BeforeModelCallEvent, (event) => {
        resolve(event.projectedInputTokens)
      })
    })
  }

  it('uses full estimation on cold start (no prior usage metadata)', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: 'Hello' })
    const countTokensSpy = vi.spyOn(model, 'countTokens')
    countTokensSpy.mockResolvedValue(42)

    const agent = new Agent({ model, printer: false })
    const tokenPromise = captureProjectedTokens(agent)
    await agent.invoke('Hi')

    expect(await tokenPromise).toBe(42)
    expect(countTokensSpy).toHaveBeenCalledWith(expect.any(Array), expect.any(Object))
  })

  it('uses known baseline when no new messages after last assistant', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: 'Hello' })

    const agent = new Agent({
      model,
      printer: false,
      messages: [
        new Message({ role: 'user', content: [new TextBlock('Hi')] }),
        new Message({
          role: 'assistant',
          content: [new TextBlock('Hello')],
          metadata: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
        }),
      ],
    })

    // Invoke with no args — no new user message appended, so the last assistant
    // message is still the final message and newMessages.length === 0
    const tokenPromise = captureProjectedTokens(agent)
    await agent.invoke([])

    // baseline = inputTokens(100) + outputTokens(20) = 120
    expect(await tokenPromise).toBe(120)
  })

  // Regression for #3546: on a disjoint provider (Bedrock/Anthropic) the cache read adds to inputTokens
  // and must be counted in the baseline, or a large cached prompt reads as a handful of tokens and
  // proactive compaction never fires.
  it('counts disjoint-provider cache reads in the known baseline', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: 'Hello' })

    const agent = new Agent({
      model,
      printer: false,
      messages: [
        new Message({ role: 'user', content: [new TextBlock('Hi')] }),
        new Message({
          role: 'assistant',
          content: [new TextBlock('Hello')],
          metadata: {
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 5862, cacheReadInputTokens: 5848 },
          },
        }),
      ],
    })

    const tokenPromise = captureProjectedTokens(agent)
    await agent.invoke([])

    // baseline = total prompt (10 + 5848 cache read) + outputTokens(4) = 5862, not 14
    expect(await tokenPromise).toBe(5862)
  })

  it('returns undefined projectedInputTokens when estimation fails', async () => {
    const model = new MockMessageModel()
    model.addTurn({ type: 'textBlock', text: 'Hello' })
    vi.spyOn(model, 'countTokens').mockRejectedValue(new Error('API unavailable'))

    const agent = new Agent({ model, printer: false })
    const tokenPromise = captureProjectedTokens(agent)
    await agent.invoke('Hi')

    expect(await tokenPromise).toBeUndefined()
  })

  it('estimates delta for new messages after last assistant', async () => {
    const model = new MockMessageModel()
    model
      .addTurn([{ type: 'toolUseBlock', name: 'test', toolUseId: 'id-1', input: {} }], {
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      })
      .addTurn({ type: 'textBlock', text: 'Done' })
    const countTokensSpy = vi.spyOn(model, 'countTokens')
    countTokensSpy.mockResolvedValue(50)

    const tool = createMockTool(
      'test',
      () =>
        new ToolResultBlock({
          toolUseId: 'id-1',
          status: 'success' as const,
          content: [new TextBlock('result')],
        })
    )
    const agent = new Agent({ model, tools: [tool], printer: false })

    // Capture the second BeforeModelCallEvent (after tool execution)
    let callCount = 0
    const tokenPromise = new Promise<number | undefined>((resolve) => {
      agent.addHook(BeforeModelCallEvent, (event) => {
        callCount++
        if (callCount === 2) resolve(event.projectedInputTokens)
      })
    })

    await agent.invoke('Use the tool')

    // baseline (100+30) + estimated delta (50) = 180
    expect(await tokenPromise).toBe(180)
    expect(countTokensSpy).toHaveBeenCalled()
  })

  it('uses baseline from prior invocation on second invoke', async () => {
    const model = new MockMessageModel()
    model
      .addTurn(
        { type: 'textBlock', text: 'First response' },
        { usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 } }
      )
      .addTurn({ type: 'textBlock', text: 'Second response' })
    const countTokensSpy = vi.spyOn(model, 'countTokens')
    countTokensSpy.mockResolvedValue(15)

    const agent = new Agent({ model, printer: false })
    await agent.invoke('First question')

    // Second invocation — the user message "Second question" is appended after
    // the assistant message with usage metadata, so it hits the baseline + delta path
    const tokenPromise = captureProjectedTokens(agent)
    await agent.invoke('Second question')

    // baseline (200+50) + estimated delta for new user message (15) = 265
    expect(await tokenPromise).toBe(265)
  })
})

describe('normalizeToolUseNames', () => {
  it('replaces invalid tool-use names with INVALID_TOOL_NAME before calling model', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const streamSpy = vi.spyOn(model, 'stream')

    const agent = new Agent({
      model,
      printer: false,
      messages: [
        new Message({ role: 'user', content: [new TextBlock('do thing')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'bad name!', toolUseId: 'tu-1', input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tu-1',
              status: 'success',
              content: [new TextBlock('result')],
            }),
          ],
        }),
      ],
    })

    await agent.invoke('continue')

    const sentMessages = streamSpy.mock.calls[0]?.[0] as Message[]
    const sentToolUse = sentMessages
      .find((m) => m.role === 'assistant')!
      .content.find((b) => b.type === 'toolUseBlock') as ToolUseBlock
    expect(sentToolUse).toStrictEqual(new ToolUseBlock({ name: 'INVALID_TOOL_NAME', toolUseId: 'tu-1', input: {} }))

    // Agent's stored history is not mutated.
    const storedToolUse = agent.messages
      .find((m) => m.role === 'assistant')!
      .content.find((b) => b.type === 'toolUseBlock') as ToolUseBlock
    expect(storedToolUse).toStrictEqual(new ToolUseBlock({ name: 'bad name!', toolUseId: 'tu-1', input: {} }))
  })

  it('preserves reasoningSignature on replaced tool-use blocks', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const streamSpy = vi.spyOn(model, 'stream')

    const agent = new Agent({
      model,
      printer: false,
      messages: [
        new Message({ role: 'user', content: [new TextBlock('do thing')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'bad!', toolUseId: 'tu-1', input: {}, reasoningSignature: 'sig-abc' })],
        }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('ok')] })],
        }),
      ],
    })

    await agent.invoke('continue')

    const sentMessages = streamSpy.mock.calls[0]?.[0] as Message[]
    const sentToolUse = sentMessages
      .find((m) => m.role === 'assistant')!
      .content.find((b) => b.type === 'toolUseBlock') as ToolUseBlock
    expect(sentToolUse).toStrictEqual(
      new ToolUseBlock({
        name: 'INVALID_TOOL_NAME',
        toolUseId: 'tu-1',
        input: {},
        reasoningSignature: 'sig-abc',
      })
    )
  })

  it('leaves valid names untouched', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const streamSpy = vi.spyOn(model, 'stream')

    const agent = new Agent({
      model,
      printer: false,
      messages: [
        new Message({ role: 'user', content: [new TextBlock('do thing')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'good_tool-1', toolUseId: 'tu-1', input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tu-1',
              status: 'success',
              content: [new TextBlock('result')],
            }),
          ],
        }),
      ],
    })

    await agent.invoke('continue')

    const sentMessages = streamSpy.mock.calls[0]?.[0] as Message[]
    const sentToolUse = sentMessages
      .find((m) => m.role === 'assistant')!
      .content.find((b) => b.type === 'toolUseBlock') as ToolUseBlock
    expect(sentToolUse).toStrictEqual(new ToolUseBlock({ name: 'good_tool-1', toolUseId: 'tu-1', input: {} }))
  })

  describe('MCP toolsChanged integration', () => {
    it('removes old tools and adds new tools when onToolsChanged fires', async () => {
      const mcpClient = new McpClient({
        transport: { start: vi.fn(), send: vi.fn(), close: vi.fn() } as never,
      })

      const initialTools = [
        new McpTool({ name: 'tool_a', description: 'A', inputSchema: {}, client: mcpClient }),
        new McpTool({ name: 'tool_b', description: 'B', inputSchema: {}, client: mcpClient }),
      ]
      vi.spyOn(mcpClient, 'listTools').mockResolvedValue(initialTools)

      let capturedCallback: ((oldTools: string[], newTools: McpTool[]) => void) | undefined
      const setterSpy = vi.spyOn(McpClient.prototype, 'onToolsChanged', 'set').mockImplementation((cb) => {
        capturedCallback = cb
      })

      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' })
      const agent = new Agent({ model, tools: [mcpClient] })
      await agent.initialize()

      expect(agent.tools.map((t) => t.name)).toEqual(['tool_a', 'tool_b'])
      expect(capturedCallback).toBeDefined()

      const newTools = [
        new McpTool({ name: 'tool_b', description: 'B-updated', inputSchema: {}, client: mcpClient }),
        new McpTool({ name: 'tool_c', description: 'C', inputSchema: {}, client: mcpClient }),
      ]

      capturedCallback!(['tool_a', 'tool_b'], newTools)

      expect(agent.tools.map((t) => t.name)).toEqual(['tool_b', 'tool_c'])
      expect(agent.tools.find((t) => t.name === 'tool_b')!.description).toBe('B-updated')

      setterSpy.mockRestore()
    })
  })

  describe('limits', () => {
    const toolUseTurn = (
      toolUseId: string,
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    ): Parameters<MockMessageModel['addTurn']> => [
      { type: 'toolUseBlock', name: 'loop', toolUseId, input: {} },
      { usage },
    ]

    const passthroughTool = (): ReturnType<typeof createMockTool> =>
      createMockTool(
        'loop',
        (context) =>
          new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success' as const,
            content: [new TextBlock('ok')],
          })
      )

    describe('when limits.turns is reached', () => {
      it('runs the cycle to completion and bails at top of next iteration', async () => {
        const model = new MockMessageModel()
          .addTurn(...toolUseTurn('tool-1', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }))
          .addTurn(...toolUseTurn('tool-2', { inputTokens: 20, outputTokens: 5, totalTokens: 25 }))

        const agent = new Agent({ model, tools: [passthroughTool()] })

        const result = await agent.invoke('go', { limits: { turns: 1 } })

        // Bail after tools — lastMessage is the user toolResult, so we don't
        // use expectAgentResult (which assumes role 'assistant').
        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitTurns',
            lastMessage: expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([expect.any(ToolResultBlock)]),
            }),
            metrics: expectLoopMetrics({
              cycleCount: 1,
              toolNames: ['loop'],
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            }),
          })
        )
      })
    })

    describe('when limits is generous', () => {
      it('does not trip and the model ends naturally', async () => {
        const model = new MockMessageModel().addTurn(
          { type: 'textBlock', text: 'done' },
          { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }
        )
        const agent = new Agent({ model })

        const result = await agent.invoke('go', { limits: { turns: 5, outputTokens: 1000, totalTokens: 1000 } })

        expect(result).toEqual(
          expectAgentResult({
            stopReason: 'endTurn',
            messageText: 'done',
            cycleCount: 1,
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          })
        )
      })
    })

    describe('when limits.outputTokens is reached', () => {
      it('returns limitOutputTokens once cumulative outputTokens hits the cap', async () => {
        const model = new MockMessageModel()
          .addTurn(...toolUseTurn('tool-1', { inputTokens: 10, outputTokens: 60, totalTokens: 70 }))
          .addTurn(...toolUseTurn('tool-2', { inputTokens: 10, outputTokens: 60, totalTokens: 70 }))

        const agent = new Agent({ model, tools: [passthroughTool()] })

        const result = await agent.invoke('go', { limits: { outputTokens: 100 } })

        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitOutputTokens',
            lastMessage: expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([expect.any(ToolResultBlock)]),
            }),
            metrics: expectLoopMetrics({
              cycleCount: 2,
              toolNames: ['loop'],
              usage: { inputTokens: 20, outputTokens: 120, totalTokens: 140 },
            }),
          })
        )
      })

      it('uses at-most (>=) semantics: stops when count exactly equals the cap', async () => {
        const model = new MockMessageModel()
          .addTurn(...toolUseTurn('tool-1', { inputTokens: 10, outputTokens: 100, totalTokens: 110 }))
          .addTurn(...toolUseTurn('tool-2', { inputTokens: 10, outputTokens: 100, totalTokens: 110 }))

        const agent = new Agent({ model, tools: [passthroughTool()] })

        const result = await agent.invoke('go', { limits: { outputTokens: 100 } })

        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitOutputTokens',
            metrics: expectLoopMetrics({
              cycleCount: 1,
              toolNames: ['loop'],
              usage: { inputTokens: 10, outputTokens: 100, totalTokens: 110 },
            }),
          })
        )
      })
    })

    describe('when limits.totalTokens is reached', () => {
      it('returns limitTotalTokens once cumulative totalTokens hits the cap', async () => {
        const model = new MockMessageModel()
          .addTurn(...toolUseTurn('tool-1', { inputTokens: 200, outputTokens: 100, totalTokens: 300 }))
          .addTurn(...toolUseTurn('tool-2', { inputTokens: 200, outputTokens: 100, totalTokens: 300 }))

        const agent = new Agent({ model, tools: [passthroughTool()] })

        const result = await agent.invoke('go', { limits: { totalTokens: 500 } })

        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitTotalTokens',
            lastMessage: expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([expect.any(ToolResultBlock)]),
            }),
            metrics: expectLoopMetrics({
              cycleCount: 2,
              toolNames: ['loop'],
              usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 },
            }),
          })
        )
      })
    })

    describe('when the model ends naturally on the same turn the limit would trip', () => {
      it('returns endTurn — the model answer wins', async () => {
        const model = new MockMessageModel().addTurn(
          { type: 'textBlock', text: 'final answer' },
          { usage: { inputTokens: 300, outputTokens: 300, totalTokens: 600 } }
        )
        const agent = new Agent({ model })

        const result = await agent.invoke('go', { limits: { totalTokens: 500 } })

        expect(result).toEqual(
          expectAgentResult({
            stopReason: 'endTurn',
            messageText: 'final answer',
            cycleCount: 1,
            usage: { inputTokens: 300, outputTokens: 300, totalTokens: 600 },
          })
        )
      })
    })

    describe('when multiple limits trip simultaneously', () => {
      const heavyUsage = { inputTokens: 100, outputTokens: 100, totalTokens: 200 }

      const buildAgent = (): Agent => {
        const model = new MockMessageModel()
          .addTurn(...toolUseTurn('tool-1', heavyUsage))
          .addTurn(...toolUseTurn('tool-2', heavyUsage))
        return new Agent({ model, tools: [passthroughTool()] })
      }

      it('prefers turns when all three trip', async () => {
        const result = await buildAgent().invoke('go', {
          limits: { turns: 1, totalTokens: 1, outputTokens: 1 },
        })

        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitTurns',
            metrics: expectLoopMetrics({ cycleCount: 1, toolNames: ['loop'] }),
          })
        )
      })

      it('prefers totalTokens over outputTokens', async () => {
        const result = await buildAgent().invoke('go', { limits: { totalTokens: 1, outputTokens: 1 } })

        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitTotalTokens',
            metrics: expectLoopMetrics({ cycleCount: 1, toolNames: ['loop'] }),
          })
        )
      })

      it('falls back to outputTokens when no higher-priority cap is set', async () => {
        const result = await buildAgent().invoke('go', { limits: { outputTokens: 1 } })

        expect(result).toEqual(
          expect.objectContaining({
            type: 'agentResult',
            stopReason: 'limitOutputTokens',
            metrics: expectLoopMetrics({ cycleCount: 1, toolNames: ['loop'] }),
          })
        )
      })
    })

    describe('when the same agent is reused across invocations', () => {
      it('scopes the limit to the current invocation, not lifetime', async () => {
        // Each turn uses 50 output tokens. With limits.outputTokens: 75, a single
        // invocation tolerates one turn but trips on the second. If the cap
        // were lifetime-scoped, the second `invoke()` would trip on its first
        // turn (75 cumulative across both calls).
        const model = new MockMessageModel()
          .addTurn(
            { type: 'textBlock', text: 'first' },
            { usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 } }
          )
          .addTurn(
            { type: 'textBlock', text: 'second' },
            { usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 } }
          )

        const agent = new Agent({ model })

        const r1 = await agent.invoke('go', { limits: { outputTokens: 75 } })
        expect(r1.stopReason).toBe('endTurn')
        expect(r1.metrics?.latestAgentInvocation?.cycles.length).toBe(1)

        const r2 = await agent.invoke('go again', { limits: { outputTokens: 75 } })
        expect(r2.stopReason).toBe('endTurn')
        expect(r2.metrics?.latestAgentInvocation?.cycles.length).toBe(1)
      })
    })

    describe('when a limit is invalid', () => {
      it.each([
        ['negative', { limits: { turns: -1 } }],
        ['zero', { limits: { turns: 0 } }],
        ['NaN', { limits: { outputTokens: NaN } }],
        ['Infinity', { limits: { totalTokens: Infinity } }],
      ])('rejects %s with TypeError', async (_label, options) => {
        const agent = new Agent({ model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'never reached' }) })
        await expect(agent.invoke('go', options)).rejects.toThrow(TypeError)
      })
    })

    describe('when invoked via stream()', () => {
      it('returns limitTurns as the generator return value', async () => {
        const model = new MockMessageModel()
          .addTurn(...toolUseTurn('tool-1', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }))
          .addTurn(...toolUseTurn('tool-2', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }))

        const agent = new Agent({ model, tools: [passthroughTool()] })

        const { result } = await collectGenerator(agent.stream('go', { limits: { turns: 1 } }))

        expect(result).toEqual(expect.objectContaining({ type: 'agentResult', stopReason: 'limitTurns' }))
      })
    })
  })

  describe('sessionId', () => {
    it('returns a stable 8-character string when no session manager is attached', () => {
      const agent = new Agent({ model: new MockMessageModel() })

      const first = agent.sessionId
      const second = agent.sessionId

      expect(first).toBe(second)
      expect(first).toHaveLength(8)
    })

    it('returns different IDs for different agent instances', () => {
      const agent1 = new Agent({ model: new MockMessageModel() })
      const agent2 = new Agent({ model: new MockMessageModel() })

      expect(agent1.sessionId).not.toBe(agent2.sessionId)
    })

    it('delegates to sessionManager when attached', () => {
      const sessionManager = new SessionManager({ sessionId: 'my-session' })
      const agent = new Agent({ model: new MockMessageModel(), sessionManager })

      expect(agent.sessionId).toBe('my-session')
    })
  })

  describe('agentMetadata', () => {
    class RecordingModel extends MockMessageModel {
      readonly receivedOptions: StreamOptions[] = []

      override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
        this.receivedOptions.push(options ?? {})
        yield* super.stream(messages, options)
      }
    }

    it('forwards the session id to the model when a session manager is attached', async () => {
      const model = new RecordingModel().addTurn({ type: 'textBlock', text: 'ok' })
      const sessionManager = new SessionManager({ sessionId: 'my-session', storage: new InMemoryStorage() })
      const agent = new Agent({ model, sessionManager, printer: false })

      await agent.invoke('hi')

      expect(model.receivedOptions[0]?.agentMetadata).toEqual({ sessionId: 'my-session' })
    })

    it('sends no agent metadata when no session manager is attached', async () => {
      const model = new RecordingModel().addTurn({ type: 'textBlock', text: 'ok' })
      const agent = new Agent({ model, printer: false })

      await agent.invoke('hi')

      expect(model.receivedOptions).toHaveLength(1)
      expect(model.receivedOptions[0]?.agentMetadata).toBeUndefined()
    })

    it('routes each agent on its own session when one model is shared across sessions', async () => {
      // Guards against the cross-session cache bleed a construction-time key fill would introduce.
      const model = new RecordingModel().addTurn({ type: 'textBlock', text: 'ok' })
      const agentS1 = new Agent({
        model,
        sessionManager: new SessionManager({ sessionId: 's1', storage: new InMemoryStorage() }),
        printer: false,
      })
      const agentS2 = new Agent({
        model,
        sessionManager: new SessionManager({ sessionId: 's2', storage: new InMemoryStorage() }),
        printer: false,
      })

      await agentS1.invoke('hi')
      await agentS2.invoke('hi')

      const sessionIds = model.receivedOptions.map((options) => options.agentMetadata?.sessionId)
      expect(sessionIds).toEqual(['s1', 's2'])
    })
  })
})
