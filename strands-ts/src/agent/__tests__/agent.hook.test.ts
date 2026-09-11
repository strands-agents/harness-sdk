import { beforeEach, describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  AfterToolsEvent,
  AgentResultEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  BeforeToolsEvent,
  MessageAddedEvent,
  ModelStreamUpdateEvent,
  InitializedEvent,
  HookableEvent,
  ModelMessageEvent,
} from '../../hooks/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { MockPlugin } from '../../__fixtures__/mock-plugin.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { expectAgentResult } from '../../__fixtures__/agent-helpers.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Tool } from '../../tools/tool.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

describe('Agent Hooks Integration', () => {
  let mockPlugin: MockPlugin

  beforeEach(() => {
    mockPlugin = new MockPlugin()
  })

  describe('invocation lifecycle', () => {
    it('fires hooks during invoke', async () => {
      const lifecyclePlugin = new MockPlugin()
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [lifecyclePlugin] })

      await agent.invoke('Hi')

      expect(lifecyclePlugin.invocations).toHaveLength(7)

      expect(lifecyclePlugin.invocations[0]).toEqual(new InitializedEvent({ agent }))
      expect(lifecyclePlugin.invocations[1]).toEqual(new BeforeInvocationEvent({ agent, invocationState: {} }))
      expect(lifecyclePlugin.invocations[2]).toEqual(
        new MessageAddedEvent({
          agent,
          message: new Message({
            role: 'user',
            content: [new TextBlock('Hi')],
            trackingId: anyTrackingId,
          }),
          invocationState: {},
        })
      )
      expect(lifecyclePlugin.invocations[3]).toEqual(
        new BeforeModelCallEvent({
          agent,
          model: agent.model,
          invocationState: {},
          projectedInputTokens: expect.any(Number) as number,
        })
      )
      expect(lifecyclePlugin.invocations[4]).toEqual(
        new AfterModelCallEvent({
          agent,
          model: agent.model,
          invocationState: {},
          attemptCount: 1,
          stopData: {
            stopReason: 'endTurn',
            message: new Message({
              role: 'assistant',
              content: [new TextBlock('Hello')],
              trackingId: anyTrackingId,
            }),
          },
        })
      )
      expect(lifecyclePlugin.invocations[5]).toEqual(
        new MessageAddedEvent({
          agent,
          message: new Message({
            role: 'assistant',
            content: [new TextBlock('Hello')],
            trackingId: anyTrackingId,
          }),
          invocationState: {},
        })
      )
      expect(lifecyclePlugin.invocations[6]).toEqual(new AfterInvocationEvent({ agent, invocationState: {} }))
    })

    it('fires hooks during stream', async () => {
      const lifecyclePlugin = new MockPlugin()
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [lifecyclePlugin] })

      await collectIterator(agent.stream('Hi'))

      expect(lifecyclePlugin.invocations).toHaveLength(7)

      expect(lifecyclePlugin.invocations[0]).toEqual(new InitializedEvent({ agent }))
      expect(lifecyclePlugin.invocations[1]).toEqual(new BeforeInvocationEvent({ agent, invocationState: {} }))
      expect(lifecyclePlugin.invocations[2]).toEqual(
        new MessageAddedEvent({
          agent,
          message: new Message({
            role: 'user',
            content: [new TextBlock('Hi')],
            trackingId: anyTrackingId,
          }),
          invocationState: {},
        })
      )
      expect(lifecyclePlugin.invocations[3]).toEqual(
        new BeforeModelCallEvent({
          agent,
          model: agent.model,
          invocationState: {},
          projectedInputTokens: expect.any(Number) as number,
        })
      )
      expect(lifecyclePlugin.invocations[4]).toEqual(
        new AfterModelCallEvent({
          agent,
          model: agent.model,
          invocationState: {},
          attemptCount: 1,
          stopData: {
            stopReason: 'endTurn',
            message: new Message({
              role: 'assistant',
              content: [new TextBlock('Hello')],
              trackingId: anyTrackingId,
            }),
          },
        })
      )
      expect(lifecyclePlugin.invocations[5]).toEqual(
        new MessageAddedEvent({
          agent,
          message: new Message({
            role: 'assistant',
            content: [new TextBlock('Hello')],
            trackingId: anyTrackingId,
          }),
          invocationState: {},
        })
      )
      expect(lifecyclePlugin.invocations[6]).toEqual(new AfterInvocationEvent({ agent, invocationState: {} }))
    })
  })

  describe('runtime hook registration', () => {
    it('allows adding hooks after agent creation via addHook', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      // Track events via individual hook registrations
      const invocations: HookableEvent[] = []
      agent.addHook(BeforeInvocationEvent, (e) => {
        invocations.push(e)
      })
      agent.addHook(AfterInvocationEvent, (e) => {
        invocations.push(e)
      })

      await agent.invoke('Hi')

      expect(invocations).toHaveLength(2)
      expect(invocations[0]).toEqual(new BeforeInvocationEvent({ agent, invocationState: {} }))
      expect(invocations[1]).toEqual(new AfterInvocationEvent({ agent, invocationState: {} }))
    })
  })

  describe('multi-turn conversations', () => {
    it('fires hooks for each invoke call', async () => {
      const lifecyclePlugin = new MockPlugin()
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First response' })
        .addTurn({ type: 'textBlock', text: 'Second response' })

      const agent = new Agent({ model, plugins: [lifecyclePlugin] })

      await agent.invoke('First message')

      // First turn: InitializedEvent + BeforeInvocation, MessageAdded, BeforeModelCall, AfterModelCall, MessageAdded, AfterInvocation
      expect(lifecyclePlugin.invocations).toHaveLength(7)

      await agent.invoke('Second message')

      // Should have 13 events total (7 for first turn + 6 for second turn, no InitializedEvent on second)
      expect(lifecyclePlugin.invocations).toHaveLength(13)

      // Filter for just Invocation events to verify they fire for each turn
      const invocationEvents = lifecyclePlugin.invocations.filter(
        (e) => e instanceof BeforeInvocationEvent || e instanceof AfterInvocationEvent
      )
      expect(invocationEvents).toHaveLength(4) // 2 for each turn
    })
  })

  describe('tool execution hooks', () => {
    it('fires tool hooks during tool execution', async () => {
      const tool = createMockTool('testTool', () => {
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Tool result')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Final response' })

      const agent = new Agent({
        model,
        tools: [tool],
        plugins: [mockPlugin],
      })

      await agent.invoke('Test with tool')

      // Find key events
      const beforeToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof BeforeToolCallEvent)
      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      const messageAddedEvents = mockPlugin.invocations.filter((e) => e instanceof MessageAddedEvent)

      // Verify tool hooks fired
      expect(beforeToolCallEvents.length).toBe(1)
      expect(afterToolCallEvents.length).toBe(1)

      // Verify 3 MessageAdded events: input message, assistant with tool use, tool result, final assistant
      expect(messageAddedEvents.length).toBe(4)

      // Verify BeforeToolCallEvent
      const beforeToolCall = beforeToolCallEvents[0] as BeforeToolCallEvent
      expect(beforeToolCall).toEqual(
        new BeforeToolCallEvent({
          agent,
          toolUse: { name: 'testTool', toolUseId: 'tool-1', input: {} },
          tool,
          invocationState: {},
        })
      )

      // Verify AfterToolCallEvent
      const afterToolCall = afterToolCallEvents[0] as AfterToolCallEvent
      expect(afterToolCall).toEqual(
        new AfterToolCallEvent({
          agent,
          toolUse: { name: 'testTool', toolUseId: 'tool-1', input: {} },
          tool,
          result: new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('Tool result')],
          }),
          invocationState: {},
        })
      )
    })

    it('fires AfterToolCallEvent with error when tool fails', async () => {
      const tool = createMockTool('failingTool', () => {
        throw new Error('Tool execution failed')
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'failingTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Handled error' })

      const agent = new Agent({
        model,
        tools: [tool],
        plugins: [mockPlugin],
      })

      // Agent should complete successfully (tool errors are handled gracefully)
      const result = await agent.invoke('Test with failing tool')
      expect(result.stopReason).toBe('endTurn')

      // Find AfterToolCallEvent
      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      expect(afterToolCallEvents.length).toBe(1)

      const afterToolCall = afterToolCallEvents[0] as AfterToolCallEvent
      expect(afterToolCall).toEqual(
        new AfterToolCallEvent({
          agent,
          toolUse: { name: 'failingTool', toolUseId: 'tool-1', input: {} },
          tool,
          result: new ToolResultBlock({
            error: new Error('Tool execution failed'),
            toolUseId: 'tool-1',
            status: 'error',
            content: [new TextBlock('Tool execution failed')],
          }),
          error: new Error('Tool execution failed'),
          invocationState: {},
        })
      )
    })
  })

  describe('ModelStreamUpdateEvent', () => {
    it('is yielded in the stream and dispatched to hooks', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })

      const streamUpdateEvents: ModelStreamUpdateEvent[] = []
      const agent = new Agent({ model })
      agent.addHook(ModelStreamUpdateEvent, (event: ModelStreamUpdateEvent) => {
        streamUpdateEvents.push(event)
      })

      // Collect all stream events
      const allStreamEvents = []
      for await (const event of agent.stream('Test')) {
        allStreamEvents.push(event)
      }

      // Should be yielded in the stream
      const streamUpdates = allStreamEvents.filter((e) => e instanceof ModelStreamUpdateEvent)
      expect(streamUpdates.length).toBeGreaterThan(0)

      // Should also fire as hook
      expect(streamUpdateEvents.length).toBeGreaterThan(0)

      // Stream and hook should receive the same event instances
      expect(streamUpdates).toStrictEqual(streamUpdateEvents)
    })
  })

  describe('MessageAddedEvent', () => {
    it('fires for initial user input', async () => {
      const initialMessage = { role: 'user' as const, content: [{ type: 'textBlock' as const, text: 'Initial' }] }

      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })

      const agent = new Agent({
        model,
        messages: [initialMessage],
        plugins: [mockPlugin],
      })

      await agent.invoke('New message')

      const messageAddedEvents = mockPlugin.invocations.filter((e) => e instanceof MessageAddedEvent)

      // Should have 2 MessageAdded event
      expect(messageAddedEvents).toHaveLength(2)

      expect(messageAddedEvents[0]).toEqual(
        new MessageAddedEvent({
          agent,
          message: new Message({
            role: 'user',
            content: [new TextBlock('New message')],
            trackingId: anyTrackingId,
          }),
          invocationState: {},
        })
      )
      expect(messageAddedEvents[1]).toEqual(
        new MessageAddedEvent({
          agent,
          message: new Message({
            role: 'assistant',
            content: [new TextBlock('Response')],
            trackingId: anyTrackingId,
          }),
          invocationState: {},
        })
      )
    })
  })

  describe('AfterModelCallEvent retry', () => {
    it('does not duplicate user messages on error retry', async () => {
      const model = new MockMessageModel()
        .addTurn(new Error('context overflow'))
        .addTurn({ type: 'textBlock', text: 'Success' })

      const agent = new Agent({ model, printer: false })
      agent.addHook(AfterModelCallEvent, (event: AfterModelCallEvent) => {
        if (event.error) {
          event.retry = true
        }
      })

      await agent.invoke('Hello')

      // Count user messages with "Hello" — should be exactly 1
      const userMessages = agent.messages.filter(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'textBlock' && b.text === 'Hello')
      )
      expect(userMessages).toHaveLength(1)
    })

    it('does not duplicate user messages on success retry', async () => {
      let callCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First' })
        .addTurn({ type: 'textBlock', text: 'Second' })

      const agent = new Agent({ model, printer: false })
      agent.addHook(AfterModelCallEvent, (event: AfterModelCallEvent) => {
        callCount++
        if (callCount === 1 && !event.error) {
          event.retry = true
        }
      })

      await agent.invoke('Hello')

      const userMessages = agent.messages.filter(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'textBlock' && b.text === 'Hello')
      )
      expect(userMessages).toHaveLength(1)
    })

    it('retries model call when hook sets retry', async () => {
      let callCount = 0
      const model = new MockMessageModel()
        .addTurn(new Error('First attempt failed'))
        .addTurn({ type: 'textBlock', text: 'Success after retry' })

      const agent = new Agent({ model })
      agent.addHook(AfterModelCallEvent, (event: AfterModelCallEvent) => {
        callCount++
        if (callCount === 1 && event.error) {
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'Success after retry' })
      expect(callCount).toBe(2)
    })

    it('does not retry when retry is not set', async () => {
      const model = new MockMessageModel().addTurn(new Error('Failure'))
      const agent = new Agent({ model })

      await expect(agent.invoke('Test')).rejects.toThrow('Failure')
    })

    it('retries model call on success when hook requests it', async () => {
      let callCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First response' })
        .addTurn({ type: 'textBlock', text: 'Second response after retry' })

      const agent = new Agent({ model })
      agent.addHook(AfterModelCallEvent, (event: AfterModelCallEvent) => {
        callCount++
        if (callCount === 1 && !event.error) {
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'Second response after retry' })
      expect(callCount).toBe(2)
    })
  })

  describe('AfterToolCallEvent retry', () => {
    it('retries tool call when hook sets retry', async () => {
      let toolCallCount = 0
      const tool = createMockTool('retryableTool', () => {
        toolCallCount++
        if (toolCallCount === 1) {
          throw new Error('First attempt failed')
        }
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      let hookCallCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'retryableTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        hookCallCount++
        if (hookCallCount === 1 && event.error) {
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolCallCount).toBe(2)
      expect(hookCallCount).toBe(2)
    })

    it('does not retry a tool call after agent cancellation', async () => {
      let toolCallCount = 0
      const tool = createMockTool('cancelledTool', () => {
        toolCallCount++
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Cancelled locally')],
        })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'cancelledTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      const agent = new Agent({ model, tools: [tool] })
      let hookCallCount = 0
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        hookCallCount++
        if (hookCallCount === 1) {
          agent.cancel()
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('cancelled')
      expect(toolCallCount).toBe(1)
      expect(hookCallCount).toBe(1)
    })

    it('does not retry a hook-cancelled tool after agent cancellation', async () => {
      let toolCallCount = 0
      const tool = createMockTool('cancelledTool', () => {
        toolCallCount++
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'cancelledTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.cancel = true
      })
      let hookCallCount = 0
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        hookCallCount++
        agent.cancel()
        event.retry = true
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('cancelled')
      expect(toolCallCount).toBe(0)
      expect(hookCallCount).toBe(1)
    })

    it('does not retry tool call when retry is not set', async () => {
      let toolCallCount = 0
      const tool = createMockTool('failingTool', () => {
        toolCallCount++
        throw new Error('Tool failed')
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'failingTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Handled error' })

      const agent = new Agent({ model, tools: [tool] })
      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolCallCount).toBe(1)
    })

    it('fires BeforeToolCallEvent on each retry', async () => {
      let toolCallCount = 0
      const tool = createMockTool('retryableTool', () => {
        toolCallCount++
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock(`Result ${toolCallCount}`)],
        })
      })

      let beforeCount = 0
      let afterCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'retryableTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(BeforeToolCallEvent, () => {
        beforeCount++
      })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        afterCount++
        if (afterCount === 1) {
          event.retry = true
        }
      })

      await agent.invoke('Test')

      expect(beforeCount).toBe(2)
      expect(afterCount).toBe(2)
      expect(toolCallCount).toBe(2)
    })

    it('retries tool call on success when hook requests it', async () => {
      let toolCallCount = 0
      const tool = createMockTool('successTool', () => {
        toolCallCount++
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock(`Result ${toolCallCount}`)],
        })
      })

      let hookCallCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'successTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        hookCallCount++
        if (hookCallCount === 1) {
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolCallCount).toBe(2)
      expect(hookCallCount).toBe(2)
    })
  })

  describe('cancel tool via hooks', () => {
    it('cancels individual tool call with default message when cancel is true', async () => {
      let toolExecuted = false
      const tool = createMockTool('blockedTool', () => {
        toolExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool], plugins: [mockPlugin] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.cancel = true
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)

      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      expect(afterToolCallEvents).toHaveLength(1)
      const afterEvent = afterToolCallEvents[0] as AfterToolCallEvent
      expect(afterEvent.result).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Tool cancelled by hook')],
        })
      )
    })

    it('cancels individual tool call with custom message when cancel is a string', async () => {
      let toolExecuted = false
      const tool = createMockTool('blockedTool', () => {
        toolExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool], plugins: [mockPlugin] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.cancel = 'Tool call limit exceeded'
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)

      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      expect(afterToolCallEvents).toHaveLength(1)
      const afterEvent = afterToolCallEvents[0] as AfterToolCallEvent
      expect(afterEvent.result).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Tool call limit exceeded')],
        })
      )
    })

    it('cancels only specific tools when BeforeToolCallEvent selectively cancels', async () => {
      const executedTools: string[] = []
      const tool1 = createMockTool('allowedTool', () => {
        executedTools.push('allowedTool')
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Allowed')] })
      })
      const tool2 = createMockTool('blockedTool', () => {
        executedTools.push('blockedTool')
        return new ToolResultBlock({ toolUseId: 'tool-2', status: 'success', content: [new TextBlock('Blocked')] })
      })

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'allowedTool', toolUseId: 'tool-1', input: {} },
          { type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-2', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool1, tool2], plugins: [mockPlugin] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        if (event.toolUse.name === 'blockedTool') {
          event.cancel = 'This tool is blocked'
        }
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(executedTools).toEqual(['allowedTool'])

      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      expect(afterToolCallEvents).toHaveLength(2)
      expect((afterToolCallEvents[0] as AfterToolCallEvent).result).toEqual(
        new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Allowed')] })
      )
      expect((afterToolCallEvents[1] as AfterToolCallEvent).result).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-2',
          status: 'error',
          content: [new TextBlock('This tool is blocked')],
        })
      )
    })

    it('cancels all tools with default message when BeforeToolsEvent.cancel is true', async () => {
      let toolExecuted = false
      const tool = createMockTool('blockedTool', () => {
        toolExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool], plugins: [mockPlugin] })
      agent.addHook(BeforeToolsEvent, (event: BeforeToolsEvent) => {
        event.cancel = true
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)

      const afterToolsEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolsEvent)
      expect(afterToolsEvents).toHaveLength(1)
      const afterEvent = afterToolsEvents[0] as AfterToolsEvent
      expect(afterEvent.message.content[0]).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Tool cancelled by hook')],
        })
      )
    })

    it('cancels all tools with custom message when BeforeToolsEvent.cancel is a string', async () => {
      let toolExecuted = false
      const tool = createMockTool('blockedTool', () => {
        toolExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool], plugins: [mockPlugin] })
      agent.addHook(BeforeToolsEvent, (event: BeforeToolsEvent) => {
        event.cancel = 'All tools blocked'
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(toolExecuted).toBe(false)

      const afterToolsEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolsEvent)
      expect(afterToolsEvents).toHaveLength(1)
      const afterEvent = afterToolsEvents[0] as AfterToolsEvent
      expect(afterEvent.message.content[0]).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('All tools blocked')],
        })
      )
    })

    it('cancels all tools in a batch via BeforeToolsEvent with correct toolUseIds', async () => {
      const executedTools: string[] = []
      const tool1 = createMockTool('tool1', () => {
        executedTools.push('tool1')
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Result 1')] })
      })
      const tool2 = createMockTool('tool2', () => {
        executedTools.push('tool2')
        return new ToolResultBlock({ toolUseId: 'tool-2', status: 'success', content: [new TextBlock('Result 2')] })
      })

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'tool1', toolUseId: 'tool-1', input: {} },
          { type: 'toolUseBlock', name: 'tool2', toolUseId: 'tool-2', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool1, tool2], plugins: [mockPlugin] })
      agent.addHook(BeforeToolsEvent, (event: BeforeToolsEvent) => {
        event.cancel = 'Batch cancelled'
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(executedTools).toEqual([])

      const afterToolsEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolsEvent)
      expect(afterToolsEvents).toHaveLength(1)
      const afterEvent = afterToolsEvents[0] as AfterToolsEvent
      expect(afterEvent.message.content).toEqual([
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Batch cancelled')],
        }),
        new ToolResultBlock({
          toolUseId: 'tool-2',
          status: 'error',
          content: [new TextBlock('Batch cancelled')],
        }),
      ])
    })

    it('emits cancel events correctly via stream()', async () => {
      let toolExecuted = false
      const tool = createMockTool('blockedTool', () => {
        toolExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'blockedTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.cancel = 'Cancelled via stream'
      })

      const items = await collectIterator(agent.stream('Test'))

      expect(toolExecuted).toBe(false)

      const beforeToolCallEvents = items.filter((e) => e instanceof BeforeToolCallEvent)
      const afterToolCallEvents = items.filter((e) => e instanceof AfterToolCallEvent)
      expect(beforeToolCallEvents).toHaveLength(1)
      expect(afterToolCallEvents).toHaveLength(1)

      const afterEvent = afterToolCallEvents[0] as AfterToolCallEvent
      expect(afterEvent.result).toEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'error',
          content: [new TextBlock('Cancelled via stream')],
        })
      )
    })

    it('allows retry after cancel on BeforeToolCallEvent', async () => {
      let toolCallCount = 0
      const tool = createMockTool('retryTool', () => {
        toolCallCount++
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Success')] })
      })

      let beforeCount = 0
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'retryTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        beforeCount++
        if (beforeCount === 1) {
          event.cancel = 'Not yet'
        }
      })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        if (event.result.status === 'error' && beforeCount === 1) {
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(beforeCount).toBe(2)
      expect(toolCallCount).toBe(1) // Only executed on second attempt
    })

    it('allows hooks to replace result on AfterToolCallEvent', async () => {
      const tool = createMockTool('myTool', () => {
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('original result')],
        })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        event.result = new ToolResultBlock({
          toolUseId: event.result.toolUseId,
          status: 'success',
          content: [new TextBlock('replaced result')],
        })
      })

      await agent.invoke('Test')

      const toolResultMessage = agent.messages.find(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'toolResultBlock')
      )
      const toolResultBlock = toolResultMessage!.content.find((b): b is ToolResultBlock => b.type === 'toolResultBlock')
      expect(toolResultBlock).toStrictEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('replaced result')],
        })
      )
    })
  })

  describe('AfterToolsEvent.endTurn', () => {
    const makeSingleToolSetup = (): { tool: Tool; model: MockMessageModel } => ({
      tool: createMockTool('myTool', () => {
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('result')] })
      }),
      model: new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach this' }),
    })

    it('halts the loop when endTurn is true with default message', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool], plugins: [mockPlugin] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = true
      })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({
            role: 'assistant',
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'textBlock', text: 'Turn ended early by hook after tool execution' }),
            ]),
          }),
        })
      )
      expect(model.callCount).toBe(1)
    })

    it('halts the loop with custom assistant message when endTurn is a string', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = 'enough information gathered'
      })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({
            role: 'assistant',
            content: expect.arrayContaining([
              expect.objectContaining({ type: 'textBlock', text: 'enough information gathered' }),
            ]),
          }),
        })
      )
      expect(model.callCount).toBe(1)
    })

    it('does not halt when endTurn is false (default)', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({ role: 'assistant' }),
        })
      )
      expect(model.callCount).toBe(2)
    })

    it('treats empty string endTurn as falsy (does not halt)', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = ''
      })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({ role: 'assistant' }),
        })
      )
      expect(model.callCount).toBe(2)
    })

    it('treats empty array endTurn as falsy (does not halt)', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = []
      })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({ role: 'assistant' }),
        })
      )
      expect(model.callCount).toBe(2)
    })

    it('halts with content blocks when endTurn is a ContentBlock array', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = [new TextBlock('delegated response')]
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('delegated response')])
      expect(agent.messages.at(-1)!.content).toEqual([new TextBlock('delegated response')])
      expect(model.callCount).toBe(1)
    })

    it('shallow-copies the endTurn array so later mutation does not affect history', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      const hookList = [new TextBlock('from hook')]
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = hookList
      })

      await agent.invoke('Test')

      // Mutate the hook's list after the invocation returns
      hookList.push(new TextBlock('MUTATED AFTER THE FACT'))

      // The committed message must be unchanged — the event loop shallow-copied
      expect(agent.messages.at(-1)!.content).toEqual([new TextBlock('from hook')])
    })

    it('appends tool results and default endTurn message to conversation history', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = true
      })

      await agent.invoke('Test')

      expect(agent.messages).toHaveLength(4)

      expect(agent.messages[0]!.role).toBe('user')
      expect(agent.messages[1]!.role).toBe('assistant')
      expect(agent.messages[1]!.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'toolUseBlock' })])
      )
      expect(agent.messages[2]!.role).toBe('user')
      expect(agent.messages[2]!.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'toolResultBlock' })])
      )
      expect(agent.messages[3]!.role).toBe('assistant')
      expect(agent.messages[3]!.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'textBlock', text: 'Turn ended early by hook after tool execution' }),
        ])
      )
    })

    it('halts the loop with concurrent tool execution', async () => {
      const tool1 = createMockTool('tool1', () => {
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('Result 1')] })
      })
      const tool2 = createMockTool('tool2', () => {
        return new ToolResultBlock({ toolUseId: 'tool-2', status: 'success', content: [new TextBlock('Result 2')] })
      })

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'tool1', toolUseId: 'tool-1', input: {} },
          { type: 'toolUseBlock', name: 'tool2', toolUseId: 'tool-2', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'Should not reach this' })

      const agent = new Agent({ model, tools: [tool1, tool2], toolExecutor: 'concurrent' })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = true
      })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({ role: 'assistant' }),
        })
      )
      expect(model.callCount).toBe(1)
    })

    it('emits AfterToolsEvent with endTurn via stream()', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = true
      })

      const items = await collectIterator(agent.stream('Test'))

      const afterToolsEvents = items.filter((e) => e instanceof AfterToolsEvent)
      expect(afterToolsEvents).toHaveLength(1)
      expect((afterToolsEvents[0] as AfterToolsEvent).endTurn).toBe(true)

      const resultEvents = items.filter((e) => e instanceof AgentResultEvent)
      expect(resultEvents).toHaveLength(1)
      expect((resultEvents[0] as AgentResultEvent).result.stopReason).toBe('endTurn')
    })

    it('halts even when set on a cancelled-tools AfterToolsEvent', async () => {
      const { tool, model } = makeSingleToolSetup()
      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(BeforeToolsEvent, (event: BeforeToolsEvent) => {
        event.cancel = true
      })
      agent.addHook(AfterToolsEvent, (event: AfterToolsEvent) => {
        event.endTurn = true
      })

      const result = await agent.invoke('Test')

      expect(result).toEqual(
        expect.objectContaining({
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: expect.objectContaining({ role: 'assistant' }),
        })
      )
      expect(model.callCount).toBe(1)
    })
  })

  describe('cancel invocation via hooks', () => {
    it('cancels invocation with default message when cancel is true', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeInvocationEvent, (event: BeforeInvocationEvent) => {
        event.cancel = true
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('invocation denied by hook'))

      const beforeModelCallEvents = mockPlugin.invocations.filter((e) => e instanceof BeforeModelCallEvent)
      expect(beforeModelCallEvents).toHaveLength(0)
    })

    it('cancels invocation with custom message when cancel is a string', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeInvocationEvent, (event: BeforeInvocationEvent) => {
        event.cancel = 'Unauthorized user'
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('Unauthorized user'))
    })

    it('does not append user message when invocation is cancelled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })
      agent.addHook(BeforeInvocationEvent, (event: BeforeInvocationEvent) => {
        event.cancel = true
      })

      await agent.invoke('Test')

      expect(agent.messages).toHaveLength(1)
      expect(agent.messages[0]!.role).toBe('assistant')
    })

    it('emits AfterInvocationEvent when invocation is cancelled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeInvocationEvent, (event: BeforeInvocationEvent) => {
        event.cancel = true
      })

      await agent.invoke('Test')

      const beforeInvocationEvents = mockPlugin.invocations.filter((e) => e instanceof BeforeInvocationEvent)
      const afterInvocationEvents = mockPlugin.invocations.filter((e) => e instanceof AfterInvocationEvent)
      expect(beforeInvocationEvents).toHaveLength(1)
      expect(afterInvocationEvents).toHaveLength(1)
    })
  })

  describe('cancel model call via hooks', () => {
    it('cancels model call with default message when cancel is true', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeModelCallEvent, (event: BeforeModelCallEvent) => {
        event.cancel = true
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('model call denied by hook'))
    })

    it('cancels model call with custom message when cancel is a string', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeModelCallEvent, (event: BeforeModelCallEvent) => {
        event.cancel = 'Rate limited'
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('Rate limited'))
    })

    it('emits AfterModelCallEvent when model call is cancelled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeModelCallEvent, (event: BeforeModelCallEvent) => {
        event.cancel = true
      })

      await agent.invoke('Test')

      const beforeModelCallEvents = mockPlugin.invocations.filter((e) => e instanceof BeforeModelCallEvent)
      const afterModelCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterModelCallEvent)
      expect(beforeModelCallEvents).toHaveLength(1)
      expect(afterModelCallEvents).toHaveLength(1)
    })

    it('does not emit ModelMessageEvent when model call is cancelled', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeModelCallEvent, (event: BeforeModelCallEvent) => {
        event.cancel = true
      })

      await agent.invoke('Test')

      const modelMessageEvents = mockPlugin.invocations.filter((e) => e instanceof ModelMessageEvent)
      expect(modelMessageEvents).toHaveLength(0)
    })

    it('allows retry after cancel on model call', async () => {
      let beforeCount = 0
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [mockPlugin] })
      agent.addHook(BeforeModelCallEvent, (event: BeforeModelCallEvent) => {
        beforeCount++
        if (beforeCount === 1) {
          event.cancel = 'Not yet'
        }
      })
      agent.addHook(AfterModelCallEvent, (event: AfterModelCallEvent) => {
        if (beforeCount === 1) {
          event.retry = true
        }
      })

      const result = await agent.invoke('Test')

      expect(result.stopReason).toBe('endTurn')
      expect(beforeCount).toBe(2)
      expect(result.lastMessage.content[0]).toEqual(new TextBlock('Hello'))
    })
  })

  describe('BeforeToolCallEvent selectedTool', () => {
    it('invokes the replacement tool instead of the registry tool', async () => {
      let originalExecuted = false
      let replacementExecuted = false
      const originalTool = createMockTool('originalTool', () => {
        originalExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('original')] })
      })
      const replacementTool = createMockTool('replacementTool', () => {
        replacementExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('replacement')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'originalTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [originalTool], plugins: [mockPlugin] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.selectedTool = replacementTool
      })

      await agent.invoke('Test')

      expect(originalExecuted).toBe(false)
      expect(replacementExecuted).toBe(true)

      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      expect(afterToolCallEvents).toHaveLength(1)
      expect((afterToolCallEvents[0] as AfterToolCallEvent).result.content).toEqual([new TextBlock('replacement')])
    })

    it('cancel wins over selectedTool', async () => {
      let replacementExecuted = false
      const replacementTool = createMockTool('replacementTool', () => {
        replacementExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('replacement')] })
      })
      const registryTool = createMockTool('registryTool', () => {
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('registry')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'registryTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [registryTool], plugins: [mockPlugin] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.selectedTool = replacementTool
        event.cancel = 'blocked'
      })

      await agent.invoke('Test')

      expect(replacementExecuted).toBe(false)

      // AfterToolCallEvent.tool should report the selectedTool even on the cancel path,
      // so observability hooks see a consistent `tool` value regardless of branch.
      const afterToolCallEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolCallEvent)
      expect(afterToolCallEvents).toHaveLength(1)
      expect((afterToolCallEvents[0] as AfterToolCallEvent).tool).toBe(replacementTool)
    })

    it('works with concurrent tool executor', async () => {
      let originalExecuted = false
      let replacementExecuted = false
      const originalTool = createMockTool('originalTool', () => {
        originalExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('original')] })
      })
      const replacementTool = createMockTool('replacementTool', () => {
        replacementExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('replacement')] })
      })
      const otherTool = createMockTool('otherTool', () => {
        return new ToolResultBlock({ toolUseId: 'tool-2', status: 'success', content: [new TextBlock('other')] })
      })

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'originalTool', toolUseId: 'tool-1', input: {} },
          { type: 'toolUseBlock', name: 'otherTool', toolUseId: 'tool-2', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({
        model,
        tools: [originalTool, otherTool],
        toolExecutor: 'concurrent',
      })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        if (event.toolUse.name === 'originalTool') {
          event.selectedTool = replacementTool
        }
      })

      await agent.invoke('Test')

      expect(originalExecuted).toBe(false)
      expect(replacementExecuted).toBe(true)
    })
  })

  describe('BeforeToolCallEvent toolUse mutation', () => {
    it('passes mutated input to the tool', async () => {
      const capturedInputs: unknown[] = []
      const tool = createMockTool('tool', () => {
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('ok')] })
      })
      // Wrap to capture input via the context the tool receives.
      const capturingTool = {
        ...tool,
        async *stream(context: Parameters<typeof tool.stream>[0]) {
          capturedInputs.push(context.toolUse.input)
          return yield* tool.stream(context)
        },
      }

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool', toolUseId: 'tool-1', input: { a: 1 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [capturingTool] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.toolUse.input = { a: 2, injected: true }
      })

      await agent.invoke('Test')

      expect(capturedInputs).toEqual([{ a: 2, injected: true }])
    })

    it('re-resolves the tool when hook renames toolUse.name', async () => {
      let origExecuted = false
      let renamedExecuted = false
      const origTool = createMockTool('orig', () => {
        origExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('orig')] })
      })
      const renamedTool = createMockTool('renamed', () => {
        renamedExecuted = true
        return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('renamed')] })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'orig', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [origTool, renamedTool] })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.toolUse.name = 'renamed'
      })

      await agent.invoke('Test')

      expect(origExecuted).toBe(false)
      expect(renamedExecuted).toBe(true)
    })

    it('works with concurrent tool executor', async () => {
      const capturedInputs: Record<string, unknown> = {}
      const baseA = createMockTool('toolA', () => {
        return new ToolResultBlock({ toolUseId: 'a', status: 'success', content: [new TextBlock('a done')] })
      })
      const baseB = createMockTool('toolB', () => {
        return new ToolResultBlock({ toolUseId: 'b', status: 'success', content: [new TextBlock('b done')] })
      })
      const toolA = {
        ...baseA,
        async *stream(context: Parameters<typeof baseA.stream>[0]) {
          capturedInputs[context.toolUse.name] = context.toolUse.input
          return yield* baseA.stream(context)
        },
      }
      const toolB = {
        ...baseB,
        async *stream(context: Parameters<typeof baseB.stream>[0]) {
          capturedInputs[context.toolUse.name] = context.toolUse.input
          return yield* baseB.stream(context)
        },
      }

      const model = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'toolA', toolUseId: 'a', input: { original: 'a' } },
          { type: 'toolUseBlock', name: 'toolB', toolUseId: 'b', input: { original: 'b' } },
        ])
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [toolA, toolB], toolExecutor: 'concurrent' })
      agent.addHook(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
        event.toolUse.input = { mutated: event.toolUse.name }
      })

      await agent.invoke('Test')

      expect(capturedInputs).toEqual({
        toolA: { mutated: 'toolA' },
        toolB: { mutated: 'toolB' },
      })
    })
  })

  describe('AfterToolCallEvent result mutation', () => {
    it('propagates mutated result into the conversation message', async () => {
      const tool = createMockTool('tool', () => {
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('SECRET_VALUE')],
        })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool] })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        event.result = new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('[REDACTED]')],
        })
      })

      await agent.invoke('Test')

      const toolResultMessage = agent.messages.find((m) =>
        m.content.some((b) => b.type === 'toolResultBlock' && b.toolUseId === 'tool-1')
      )
      expect(toolResultMessage).toBeDefined()
      const block = toolResultMessage!.content.find(
        (b): b is ToolResultBlock => b.type === 'toolResultBlock' && b.toolUseId === 'tool-1'
      )
      expect(block!.content).toEqual([new TextBlock('[REDACTED]')])
    })

    it('propagates mutated result into AfterToolsEvent', async () => {
      const tool = createMockTool('tool', () => {
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('SECRET_VALUE')],
        })
      })

      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'tool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const agent = new Agent({ model, tools: [tool], plugins: [mockPlugin] })
      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        event.result = new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('[REDACTED]')],
        })
      })

      await agent.invoke('Test')

      const afterToolsEvents = mockPlugin.invocations.filter((e) => e instanceof AfterToolsEvent)
      expect(afterToolsEvents).toHaveLength(1)
      const block = (afterToolsEvents[0] as AfterToolsEvent).message.content.find(
        (b): b is ToolResultBlock => b.type === 'toolResultBlock' && b.toolUseId === 'tool-1'
      )
      expect(block!.content).toEqual([new TextBlock('[REDACTED]')])
    })
  })

  describe('AfterInvocationEvent resume', () => {
    it('re-invokes the agent with the resume args', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'first' })
        .addTurn({ type: 'textBlock', text: 'second' })

      let invocationCount = 0
      const agent = new Agent({ model })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        invocationCount++
        if (invocationCount === 1) {
          event.resume = 'follow-up'
        }
      })

      const result = await agent.invoke('initial')

      expect(invocationCount).toBe(2)
      expect(result).toEqual(
        expectAgentResult({
          stopReason: 'endTurn',
          messageText: 'second',
          // Meter cycleCount is cumulative across the resume chain (1 cycle per invocation x 2).
          cycleCount: 2,
        })
      )
    })

    it('chains multiple resumes', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a' })
        .addTurn({ type: 'textBlock', text: 'b' })
        .addTurn({ type: 'textBlock', text: 'c' })

      let invocationCount = 0
      const agent = new Agent({ model })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        invocationCount++
        if (invocationCount === 1) event.resume = 'second'
        else if (invocationCount === 2) event.resume = 'third'
      })

      const result = await agent.invoke('first')

      expect(invocationCount).toBe(3)
      expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'c' })
    })

    it('does not resume when resume is left undefined', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'only' })

      let invocationCount = 0
      const agent = new Agent({ model })
      agent.addHook(AfterInvocationEvent, () => {
        invocationCount++
      })

      await agent.invoke('hi')

      expect(invocationCount).toBe(1)
    })

    it('does not resume when the invocation errors', async () => {
      const model = new MockMessageModel().addTurn(new Error('boom'))

      let invocationCount = 0
      const agent = new Agent({ model })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        invocationCount++
        event.resume = 'should-not-run'
      })

      await expect(agent.invoke('hi')).rejects.toThrow('boom')
      expect(invocationCount).toBe(1)
    })

    it('first-registered hook wins when multiple hooks set resume', async () => {
      // AfterInvocationEvent reverses callback order (_shouldReverseCallbacks=true),
      // so the first-registered hook fires last and its resume value wins.
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'first' })
        .addTurn({ type: 'textBlock', text: 'second' })

      let invocationCount = 0
      const agent = new Agent({ model })
      agent.addHook(BeforeInvocationEvent, () => {
        invocationCount++
      })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        if (invocationCount === 1) event.resume = 'first-registered wins'
      })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        if (invocationCount === 1) event.resume = 'second-registered loses'
      })

      await agent.invoke('initial')

      const userTexts = agent.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content.filter((b): b is TextBlock => b.type === 'textBlock').map((b) => b.text))
      expect(userTexts).toEqual(['initial', 'first-registered wins'])
    })

    it('ignores resume set during an erroring invocation', async () => {
      // Resume should not fire when the invocation ends with an error, even if
      // AfterInvocationEvent (which fires in _stream's finally) still runs.
      const model = new MockMessageModel().addTurn(new Error('boom'))

      let resumeFired = false
      const agent = new Agent({ model })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        event.resume = 'should not run'
      })
      agent.addHook(BeforeInvocationEvent, () => {
        // Track whether BeforeInvocationEvent fires a second time (would indicate resume ran).
        if (resumeFired) throw new Error('unexpected second invocation')
        resumeFired = true
      })

      await expect(agent.invoke('hi')).rejects.toThrow('boom')
    })

    it('emits only one AgentResultEvent for a resumed chain', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'first' })
        .addTurn({ type: 'textBlock', text: 'second' })

      let invocationCount = 0
      const agent = new Agent({ model })
      agent.addHook(AfterInvocationEvent, (event: AfterInvocationEvent) => {
        invocationCount++
        if (invocationCount === 1) {
          event.resume = 'follow-up'
        }
      })

      const items = await collectIterator(agent.stream('initial'))

      const agentResults = items.filter((e) => e instanceof AgentResultEvent)
      expect(agentResults).toHaveLength(1)
      const afterInvocations = items.filter((e) => e instanceof AfterInvocationEvent)
      expect(afterInvocations).toHaveLength(2)
    })
  })

  describe('queue-based lifecycle plugin (WASM bridge pattern)', () => {
    function createLifecycleBridgePlugin(queue: string[]): Plugin {
      return {
        name: 'strands:lifecycle-bridge',
        initAgent(agent: LocalAgent): void {
          agent.addHook(InitializedEvent, () => {
            queue.push('initialized')
          })
          agent.addHook(BeforeInvocationEvent, () => {
            queue.push('before-invocation')
          })
          agent.addHook(AfterInvocationEvent, () => {
            queue.push('after-invocation')
          })
          agent.addHook(BeforeModelCallEvent, () => {
            queue.push('before-model-call')
          })
          agent.addHook(AfterModelCallEvent, () => {
            queue.push('after-model-call')
          })
          agent.addHook(MessageAddedEvent, () => {
            queue.push('message-added')
          })
          agent.addHook(BeforeToolCallEvent, () => {
            queue.push('before-tool-call')
          })
          agent.addHook(AfterToolCallEvent, () => {
            queue.push('after-tool-call')
          })
        },
      }
    }

    it('receives lifecycle events when registered via plugins config', async () => {
      const queue: string[] = []
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, plugins: [createLifecycleBridgePlugin(queue)] })
      await agent.invoke('Hi')

      expect(queue).toStrictEqual([
        'initialized',
        'before-invocation',
        'message-added',
        'before-model-call',
        'after-model-call',
        'message-added',
        'after-invocation',
      ])
    })

    it('receives no events when passed via non-existent hooks config field', async () => {
      const queue: string[] = []
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, hooks: [createLifecycleBridgePlugin(queue)] } as any)
      await agent.invoke('Hi')

      expect(queue).toHaveLength(0)
    })
  })

  describe('plugin initialization failure', () => {
    it('keeps a plugin initialization failure fail-closed across retries', async () => {
      const initializationError = new Error('plugin initialization failed')
      const plugin: Plugin = {
        name: 'failing-plugin',
        initAgent: () => {
          throw initializationError
        },
      }
      const agent = new Agent({ model: new MockMessageModel(), plugins: [plugin] })

      await expect(agent.initialize()).rejects.toBe(initializationError)
      await expect(agent.initialize()).rejects.toBe(initializationError)
    })
  })
})
