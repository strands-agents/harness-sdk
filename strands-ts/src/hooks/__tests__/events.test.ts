import { describe, expect, it } from 'vitest'
import {
  InitializedEvent,
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  AfterToolsEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  BeforeToolsEvent,
  MessageAddedEvent,
  ModelStreamUpdateEvent,
  ContentBlockEvent,
  ModelMessageEvent,
  ToolResultEvent,
  ToolStreamUpdateEvent,
  AgentResultEvent,
} from '../events.js'
import { Agent } from '../../agent/agent.js'
import { AgentResult } from '../../types/agent.js'
import { AgentMetrics } from '../../telemetry/meter.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import { FunctionTool } from '../../tools/function-tool.js'
import { ToolStreamEvent } from '../../tools/tool.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

describe('InitializedEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const event = new InitializedEvent({ agent })

    expect(event).toEqual({
      type: 'initializedEvent',
      agent: agent,
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const event = new InitializedEvent({ agent })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })
})

describe('BeforeInvocationEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const event = new BeforeInvocationEvent({ agent, invocationState: {} })

    expect(event).toEqual({
      type: 'beforeInvocationEvent',
      agent: agent,
      cancel: false,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const event = new BeforeInvocationEvent({ agent, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  it('allows cancel to be set to true', () => {
    const agent = new Agent()
    const event = new BeforeInvocationEvent({ agent, invocationState: {} })

    expect(event.cancel).toBe(false)
    event.cancel = true
    expect(event.cancel).toBe(true)
  })

  it('allows cancel to be set to a string message', () => {
    const agent = new Agent()
    const event = new BeforeInvocationEvent({ agent, invocationState: {} })

    event.cancel = 'unauthorized'
    expect(event.cancel).toBe('unauthorized')
  })
})

describe('AfterInvocationEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const event = new AfterInvocationEvent({ agent, invocationState: {} })

    expect(event).toEqual({
      type: 'afterInvocationEvent',
      agent: agent,
      invocationState: {},
      resume: undefined,
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
  })

  it('returns true for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const event = new AfterInvocationEvent({ agent, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(true)
  })

  it('allows resume to be set to new input', () => {
    const agent = new Agent()
    const event = new AfterInvocationEvent({ agent, invocationState: {} })

    expect(event.resume).toBeUndefined()

    event.resume = 'follow-up prompt'
    expect(event.resume).toBe('follow-up prompt')
  })
})

describe('MessageAddedEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [new TextBlock('Hello')] })
    const event = new MessageAddedEvent({ agent, message, invocationState: {} })

    expect(event).toEqual({
      type: 'messageAddedEvent',
      agent: agent,
      message: message,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.message = message
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [] })
    const event = new MessageAddedEvent({ agent, message, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })
})

describe('BeforeToolCallEvent', () => {
  it('creates instance with correct properties when tool is found', () => {
    const agent = new Agent()
    const tool = new FunctionTool({
      name: 'testTool',
      description: 'Test tool',
      inputSchema: {},
      callback: () => 'result',
    })
    const toolUse = {
      name: 'testTool',
      toolUseId: 'test-id',
      input: { arg: 'value' },
    }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool, invocationState: {} })

    expect(event).toEqual({
      type: 'beforeToolCallEvent',
      agent: agent,
      toolUse: toolUse,
      tool: tool,
      cancel: false,
      invocationState: {},
      selectedTool: undefined,
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.tool = tool
  })

  it('creates instance with undefined tool when tool is not found', () => {
    const agent = new Agent()
    const toolUse = {
      name: 'unknownTool',
      toolUseId: 'test-id',
      input: {},
    }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })

    expect(event).toEqual({
      type: 'beforeToolCallEvent',
      agent: agent,
      toolUse: toolUse,
      tool: undefined,
      cancel: false,
      invocationState: {},
      selectedTool: undefined,
    })
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  it('allows cancel to be set to true', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })

    expect(event.cancel).toBe(false)
    event.cancel = true
    expect(event.cancel).toBe(true)
  })

  it('allows cancel to be set to a string message', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })

    event.cancel = 'tool not allowed'
    expect(event.cancel).toBe('tool not allowed')
  })

  it('allows selectedTool to be set to a replacement tool', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })

    expect(event.selectedTool).toBeUndefined()

    const replacement = new FunctionTool({
      name: 'replacement',
      description: 'Replacement',
      inputSchema: {},
      callback: () => 'ok',
    })
    event.selectedTool = replacement
    expect(event.selectedTool).toBe(replacement)
  })

  it('allows mutating toolUse fields in-place', () => {
    const agent = new Agent()
    const toolUse = { name: 'orig', toolUseId: 'id', input: { a: 1 } }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })

    event.toolUse.input = { a: 2, b: 3 }
    event.toolUse.name = 'renamed'
    expect(event.toolUse).toEqual({ name: 'renamed', toolUseId: 'id', input: { a: 2, b: 3 } })
  })

  it('allows reassigning toolUse to a new object', () => {
    const agent = new Agent()
    const toolUse = { name: 'orig', toolUseId: 'id', input: {} }
    const event = new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })

    event.toolUse = { name: 'new', toolUseId: 'new-id', input: { x: 1 } }
    expect(event.toolUse).toEqual({ name: 'new', toolUseId: 'new-id', input: { x: 1 } })
  })
})

describe('AfterToolCallEvent', () => {
  it('creates instance with correct properties on success', () => {
    const agent = new Agent()
    const tool = new FunctionTool({
      name: 'testTool',
      description: 'Test tool',
      inputSchema: {},
      callback: () => 'result',
    })
    const toolUse = {
      name: 'testTool',
      toolUseId: 'test-id',
      input: {},
    }
    const result = new ToolResultBlock({
      toolUseId: 'test-id',
      status: 'success',
      content: [new TextBlock('Success')],
    })
    const event = new AfterToolCallEvent({ agent, toolUse, tool, result, invocationState: {} })

    expect(event).toEqual({
      type: 'afterToolCallEvent',
      agent: agent,
      toolUse: toolUse,
      tool: tool,
      result: result,
      error: undefined,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.toolUse = toolUse
    // @ts-expect-error verifying that property is readonly
    event.tool = tool
  })

  it('allows result to be replaced', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const result = new ToolResultBlock({ toolUseId: 'id', status: 'success', content: [new TextBlock('original')] })
    const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, invocationState: {} })

    const replacedResult = new ToolResultBlock({
      toolUseId: 'id',
      status: 'success',
      content: [new TextBlock('replaced')],
    })
    event.result = replacedResult
    expect(event.result).toBe(replacedResult)
  })

  it('creates instance with error property when tool execution fails', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const result = new ToolResultBlock({
      toolUseId: 'id',
      status: 'error',
      content: [new TextBlock('Error')],
    })
    const error = new Error('Tool failed')
    const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, error, invocationState: {} })

    expect(event).toEqual({
      type: 'afterToolCallEvent',
      agent: agent,
      toolUse: toolUse,
      tool: undefined,
      result: result,
      error: error,
      invocationState: {},
    })
  })

  it('returns true for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const result = new ToolResultBlock({
      toolUseId: 'id',
      status: 'success',
      content: [],
    })
    const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(true)
  })

  it('allows retry to be set when error is present', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const result = new ToolResultBlock({
      toolUseId: 'id',
      status: 'error',
      content: [new TextBlock('Error')],
    })
    const error = new Error('Tool failed')
    const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, error, invocationState: {} })

    expect(event.retry).toBeUndefined()

    event.retry = true
    expect(event.retry).toBe(true)

    event.retry = false
    expect(event.retry).toBe(false)
  })

  it('allows retry to be set on success', () => {
    const agent = new Agent()
    const toolUse = { name: 'test', toolUseId: 'id', input: {} }
    const result = new ToolResultBlock({
      toolUseId: 'id',
      status: 'success',
      content: [new TextBlock('Success')],
    })
    const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, invocationState: {} })

    expect(event.retry).toBeUndefined()

    event.retry = true
    expect(event.retry).toBe(true)
  })
})

describe('BeforeModelCallEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const event = new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} })

    expect(event).toEqual({
      type: 'beforeModelCallEvent',
      agent: agent,
      model: agent.model,
      cancel: false,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
  })

  it('includes projectedInputTokens when provided', () => {
    const agent = new Agent()
    const event = new BeforeModelCallEvent({
      agent,
      model: agent.model,
      invocationState: {},
      projectedInputTokens: 500,
    })

    expect(event).toEqual({
      type: 'beforeModelCallEvent',
      agent,
      model: agent.model,
      cancel: false,
      invocationState: {},
      projectedInputTokens: 500,
    })
    expect(event.toJSON()).toStrictEqual({
      type: 'beforeModelCallEvent',
      projectedInputTokens: 500,
    })
  })

  it('excludes projectedInputTokens from toJSON when not provided', () => {
    const agent = new Agent()
    const event = new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} })

    expect(event.projectedInputTokens).toBeUndefined()
    expect(event.toJSON()).toStrictEqual({ type: 'beforeModelCallEvent' })
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const event = new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  it('allows cancel to be set to true', () => {
    const agent = new Agent()
    const event = new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} })

    expect(event.cancel).toBe(false)
    event.cancel = true
    expect(event.cancel).toBe(true)
  })

  it('allows cancel to be set to a string message', () => {
    const agent = new Agent()
    const event = new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} })

    event.cancel = 'rate limited'
    expect(event.cancel).toBe('rate limited')
  })
})

describe('AfterModelCallEvent', () => {
  it('creates instance with correct properties on success', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [new TextBlock('Response')] })
    const stopReason = 'endTurn'
    const response = { message, stopReason }
    const event = new AfterModelCallEvent({
      agent,
      model: agent.model,
      attemptCount: 1,
      stopData: response,
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'afterModelCallEvent',
      agent: agent,
      model: agent.model,
      attemptCount: 1,
      stopData: response,
      error: undefined,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.stopData = response
  })

  it('creates instance with error property when model invocation fails', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [] })
    const error = new Error('Model failed')
    const response = { message, stopReason: 'error' }
    const event = new AfterModelCallEvent({
      agent,
      model: agent.model,
      attemptCount: 1,
      stopData: response,
      error,
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'afterModelCallEvent',
      agent: agent,
      model: agent.model,
      attemptCount: 1,
      stopData: response,
      error: error,
      invocationState: {},
    })
  })

  it('returns true for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [] })
    const response = { message, stopReason: 'endTurn' }
    const event = new AfterModelCallEvent({
      agent,
      model: agent.model,
      attemptCount: 1,
      stopData: response,
      invocationState: {},
    })
    expect(event._shouldReverseCallbacks()).toBe(true)
  })

  it('allows retry to be set when error is present', () => {
    const agent = new Agent()
    const error = new Error('Model failed')
    const event = new AfterModelCallEvent({ agent, model: agent.model, attemptCount: 1, error, invocationState: {} })

    // Initially undefined
    expect(event.retry).toBeUndefined()

    // Can be set to true
    event.retry = true
    expect(event.retry).toBe(true)

    // Can be set to false
    event.retry = false
    expect(event.retry).toBe(false)
  })

  it('retry is optional and defaults to undefined', () => {
    const agent = new Agent()
    const error = new Error('Model failed')
    const event = new AfterModelCallEvent({ agent, model: agent.model, attemptCount: 1, error, invocationState: {} })

    expect(event.retry).toBeUndefined()
  })
})

describe('ModelStreamUpdateEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const streamEvent = {
      type: 'modelMessageStartEvent' as const,
      role: 'assistant' as const,
    }
    const hookEvent = new ModelStreamUpdateEvent({ agent, event: streamEvent, invocationState: {} })

    expect(hookEvent).toEqual({
      type: 'modelStreamUpdateEvent',
      agent: agent,
      event: streamEvent,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    hookEvent.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    hookEvent.event = streamEvent
  })
})

describe('ContentBlockEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const contentBlock = new TextBlock('Hello')
    const event = new ContentBlockEvent({ agent, contentBlock, invocationState: {} })

    expect(event).toEqual({
      type: 'contentBlockEvent',
      agent: agent,
      contentBlock: contentBlock,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.contentBlock = contentBlock
  })
})

describe('ModelMessageEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [new TextBlock('Hello')] })
    const event = new ModelMessageEvent({ agent, message, stopReason: 'endTurn', invocationState: {} })

    expect(event).toEqual({
      type: 'modelMessageEvent',
      agent: agent,
      message: message,
      stopReason: 'endTurn',
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.message = message
    // @ts-expect-error verifying that property is readonly
    event.stopReason = 'endTurn'
  })
})

describe('ToolResultEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const toolResult = new ToolResultBlock({
      toolUseId: 'test-id',
      status: 'success',
      content: [new TextBlock('Result')],
    })
    const event = new ToolResultEvent({ agent, result: toolResult, invocationState: {} })

    expect(event).toEqual({
      type: 'toolResultEvent',
      agent: agent,
      result: toolResult,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.result = toolResult
  })
})

describe('ToolStreamUpdateEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const toolStreamEvent = new ToolStreamEvent({ data: 'progress' })
    const event = new ToolStreamUpdateEvent({ agent, event: toolStreamEvent, invocationState: {} })

    expect(event).toEqual({
      type: 'toolStreamUpdateEvent',
      agent: agent,
      event: toolStreamEvent,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.event = toolStreamEvent
  })
})

describe('AgentResultEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const result = new AgentResult({
      stopReason: 'endTurn',
      lastMessage: new Message({ role: 'assistant', content: [new TextBlock('Done')] }),
      metrics: new AgentMetrics(),
      invocationState: {},
    })
    const event = new AgentResultEvent({ agent, result, invocationState: {} })

    expect(event).toEqual({
      type: 'agentResultEvent',
      agent: agent,
      result: result,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.result = result
  })
})

describe('BeforeToolsEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const message = new Message({
      role: 'assistant',
      content: [
        new ToolUseBlock({
          name: 'testTool',
          toolUseId: 'test-id',
          input: { arg: 'value' },
        }),
      ],
    })
    const event = new BeforeToolsEvent({ agent, message, invocationState: {} })

    expect(event).toEqual({
      type: 'beforeToolsEvent',
      agent: agent,
      message: message,
      cancel: false,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.message = message
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [] })
    const event = new BeforeToolsEvent({ agent, message, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  it('allows cancel to be set to true', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [] })
    const event = new BeforeToolsEvent({ agent, message, invocationState: {} })

    expect(event.cancel).toBe(false)
    event.cancel = true
    expect(event.cancel).toBe(true)
  })

  it('allows cancel to be set to a string message', () => {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [] })
    const event = new BeforeToolsEvent({ agent, message, invocationState: {} })

    event.cancel = 'tools not allowed'
    expect(event.cancel).toBe('tools not allowed')
  })
})

describe('AfterToolsEvent', () => {
  it('creates instance with correct properties', () => {
    const agent = new Agent()
    const message = new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new TextBlock('Result')],
        }),
      ],
    })
    const event = new AfterToolsEvent({ agent, message, invocationState: {} })

    expect(event).toEqual({
      type: 'afterToolsEvent',
      agent: agent,
      message: message,
      invocationState: {},
      endTurn: false,
    })
    // @ts-expect-error verifying that property is readonly
    event.agent = new Agent()
    // @ts-expect-error verifying that property is readonly
    event.message = message
  })

  it('returns true for _shouldReverseCallbacks', () => {
    const agent = new Agent()
    const message = new Message({ role: 'user', content: [] })
    const event = new AfterToolsEvent({ agent, message, invocationState: {} })
    expect(event._shouldReverseCallbacks()).toBe(true)
  })

  it('defaults endTurn to false', () => {
    const agent = new Agent()
    const message = new Message({ role: 'user', content: [] })
    const event = new AfterToolsEvent({ agent, message, invocationState: {} })

    expect(event.endTurn).toBe(false)
  })
})

// ===================== toJSON serialization tests =====================

describe('toJSON serialization', () => {
  describe('InitializedEvent', () => {
    it('excludes agent and returns only type', () => {
      const agent = new Agent()
      const event = new InitializedEvent({ agent })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({ type: 'initializedEvent' })
    })
  })

  describe('BeforeInvocationEvent', () => {
    it('excludes agent and returns only type', () => {
      const agent = new Agent()
      const event = new BeforeInvocationEvent({ agent, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({ type: 'beforeInvocationEvent' })
    })
  })

  describe('AfterInvocationEvent', () => {
    it('excludes agent and returns only type', () => {
      const agent = new Agent()
      const event = new AfterInvocationEvent({ agent, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({ type: 'afterInvocationEvent' })
    })
  })

  describe('BeforeModelCallEvent', () => {
    it('excludes agent and model and returns only type', () => {
      const agent = new Agent()
      const event = new BeforeModelCallEvent({ agent, model: agent.model, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({ type: 'beforeModelCallEvent' })
    })
  })

  describe('MessageAddedEvent', () => {
    it('includes message and excludes agent', () => {
      const agent = new Agent()
      const message = new Message({ role: 'assistant', content: [new TextBlock('Hello')] })
      const event = new MessageAddedEvent({ agent, message, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'messageAddedEvent',
        message: { role: 'assistant', content: [{ text: 'Hello' }], trackingId: anyTrackingId },
      })
    })
  })

  describe('ModelStreamUpdateEvent', () => {
    it('includes stream event and excludes agent', () => {
      const agent = new Agent()
      const streamEvent = {
        type: 'modelContentBlockDeltaEvent' as const,
        delta: { type: 'textDelta' as const, text: 'Hi' },
      }
      const event = new ModelStreamUpdateEvent({ agent, event: streamEvent, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'modelStreamUpdateEvent',
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hi' } },
      })
    })
  })

  describe('ContentBlockEvent', () => {
    it('includes content block and excludes agent', () => {
      const agent = new Agent()
      const contentBlock = new TextBlock('Hello world')
      const event = new ContentBlockEvent({ agent, contentBlock, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'contentBlockEvent',
        contentBlock: { text: 'Hello world' },
      })
    })
  })

  describe('ModelMessageEvent', () => {
    it('includes message and stopReason, excludes agent', () => {
      const agent = new Agent()
      const message = new Message({ role: 'assistant', content: [new TextBlock('Done')] })
      const event = new ModelMessageEvent({ agent, message, stopReason: 'endTurn', invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'modelMessageEvent',
        message: { role: 'assistant', content: [{ text: 'Done' }], trackingId: anyTrackingId },
        stopReason: 'endTurn',
      })
    })
  })

  describe('ToolResultEvent', () => {
    it('includes result and excludes agent', () => {
      const agent = new Agent()
      const result = new ToolResultBlock({
        toolUseId: 'tool-1',
        status: 'success',
        content: [new TextBlock('42')],
      })
      const event = new ToolResultEvent({ agent, result, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'toolResultEvent',
        result: { toolResult: { toolUseId: 'tool-1', status: 'success', content: [{ text: '42' }] } },
      })
    })
  })

  describe('ToolStreamUpdateEvent', () => {
    it('includes tool stream event and excludes agent', () => {
      const agent = new Agent()
      const toolStreamEvent = new ToolStreamEvent({ data: { progress: 50 } })
      const event = new ToolStreamUpdateEvent({ agent, event: toolStreamEvent, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'toolStreamUpdateEvent',
        event: { type: 'toolStreamEvent', data: { progress: 50 } },
      })
    })
  })

  describe('AgentResultEvent', () => {
    it('includes result and excludes agent', () => {
      const agent = new Agent()
      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: new Message({ role: 'assistant', content: [new TextBlock('Done')] }),
        metrics: new AgentMetrics(),
        invocationState: {},
      })
      const event = new AgentResultEvent({ agent, result, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'agentResultEvent',
        result: {
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: {
            role: 'assistant',
            content: [{ text: 'Done' }],
            trackingId: anyTrackingId,
          },
        },
      })
    })
  })

  describe('BeforeToolCallEvent', () => {
    it('includes toolUse and excludes agent, tool, and cancel', () => {
      const agent = new Agent()
      const tool = new FunctionTool({
        name: 'testTool',
        description: 'Test',
        inputSchema: {},
        callback: () => 'result',
      })
      const toolUse = { name: 'testTool', toolUseId: 'id-1', input: { query: 'hello' } }
      const event = new BeforeToolCallEvent({ agent, toolUse, tool, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'beforeToolCallEvent',
        toolUse: { name: 'testTool', toolUseId: 'id-1', input: { query: 'hello' } },
      })
    })
  })

  describe('AfterToolCallEvent', () => {
    it('includes toolUse and result, excludes agent and tool on success', () => {
      const agent = new Agent()
      const toolUse = { name: 'calc', toolUseId: 'id-1', input: {} }
      const result = new ToolResultBlock({
        toolUseId: 'id-1',
        status: 'success',
        content: [new TextBlock('42')],
      })
      const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'afterToolCallEvent',
        toolUse: { name: 'calc', toolUseId: 'id-1', input: {} },
        result: { toolResult: { toolUseId: 'id-1', status: 'success', content: [{ text: '42' }] } },
      })
    })

    it('converts error to message string and excludes retry', () => {
      const agent = new Agent()
      const toolUse = { name: 'calc', toolUseId: 'id-1', input: {} }
      const result = new ToolResultBlock({
        toolUseId: 'id-1',
        status: 'error',
        content: [new TextBlock('Error')],
      })
      const error = new Error('Tool crashed')
      const event = new AfterToolCallEvent({ agent, toolUse, tool: undefined, result, error, invocationState: {} })
      event.retry = true
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'afterToolCallEvent',
        toolUse: { name: 'calc', toolUseId: 'id-1', input: {} },
        result: { toolResult: { toolUseId: 'id-1', status: 'error', content: [{ text: 'Error' }] } },
        error: { message: 'Tool crashed' },
      })
    })
  })

  describe('AfterModelCallEvent', () => {
    it('includes stopData and attemptCount and excludes agent and model on success', () => {
      const agent = new Agent()
      const message = new Message({ role: 'assistant', content: [new TextBlock('Hi')] })
      const stopData = { message, stopReason: 'endTurn' as const }
      const event = new AfterModelCallEvent({
        agent,
        model: agent.model,
        attemptCount: 2,
        stopData,
        invocationState: {},
      })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'afterModelCallEvent',
        attemptCount: 2,
        stopData: {
          message: { role: 'assistant', content: [{ text: 'Hi' }], trackingId: anyTrackingId },
          stopReason: 'endTurn',
        },
      })
    })

    it('converts error to message string and excludes retry', () => {
      const agent = new Agent()
      const error = new Error('Model failed')
      const event = new AfterModelCallEvent({ agent, model: agent.model, attemptCount: 1, error, invocationState: {} })
      event.retry = true
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'afterModelCallEvent',
        attemptCount: 1,
        error: { message: 'Model failed' },
      })
    })
  })

  describe('BeforeToolsEvent', () => {
    it('includes message and excludes agent and cancel', () => {
      const agent = new Agent()
      const message = new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'calc', toolUseId: 'id-1', input: {} })],
      })
      const event = new BeforeToolsEvent({ agent, message, invocationState: {} })
      event.cancel = 'not allowed'
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'beforeToolsEvent',
        message: {
          role: 'assistant',
          content: [{ toolUse: { name: 'calc', toolUseId: 'id-1', input: {} } }],
          trackingId: anyTrackingId,
        },
      })
    })
  })

  describe('AfterToolsEvent', () => {
    it('includes message and excludes agent', () => {
      const agent = new Agent()
      const message = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'id-1',
            status: 'success',
            content: [new TextBlock('Done')],
          }),
        ],
      })
      const event = new AfterToolsEvent({ agent, message, invocationState: {} })
      const json = JSON.parse(JSON.stringify(event))

      expect(json).toStrictEqual({
        type: 'afterToolsEvent',
        message: {
          role: 'user',
          content: [{ toolResult: { toolUseId: 'id-1', status: 'success', content: [{ text: 'Done' }] } }],
          trackingId: anyTrackingId,
        },
      })
    })
  })

  describe('agent reference is never serialized', () => {
    it('JSON.stringify output never contains agent properties', () => {
      const agent = new Agent()
      // Add messages to make agent heavy
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Hello '.repeat(100))] }))

      const event = new ModelStreamUpdateEvent({
        agent,
        event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hi' } },
        invocationState: {},
      })
      const json = JSON.stringify(event)

      // Should be small (no agent serialized)
      expect(json.length).toBeLessThan(200)
      expect(json).not.toContain('Hello Hello')
      expect(json).not.toContain('appState')
      expect(json).not.toContain('toolRegistry')
    })
  })
})

// ===================== Serialization completeness tests =====================
// Ensures that if a new field is added to an event class, it must either be
// included in toJSON() or explicitly added to the exclusion set.

describe('toJSON serialization completeness', () => {
  /**
   * Fields that should NEVER appear in toJSON() output.
   * If you add a new field to an event and it should be excluded from wire serialization,
   * add it here. Otherwise, add it to toJSON() so it gets serialized.
   */
  const EXCLUDED_FIELDS = new Set([
    'agent',
    'model',
    'tool',
    'cancel',
    'retry',
    'invocationState',
    'selectedTool',
    'resume',
    'endTurn',
  ])

  /**
   * Fields where toJSON() transforms the value (e.g., Error to message object).
   * These appear in both instance and JSON but with different shapes.
   */
  const TRANSFORMED_FIELDS = new Set(['error'])

  // Helper: create a fully-populated instance of each event class
  function createEventInstances(): Array<{ name: string; event: { toJSON(): Record<string, unknown> } }> {
    const agent = new Agent()
    const message = new Message({ role: 'assistant', content: [new TextBlock('test')] })
    const toolUse = { name: 'test', toolUseId: 'id-1', input: {} }
    const result = new ToolResultBlock({ toolUseId: 'id-1', status: 'success', content: [new TextBlock('ok')] })
    const tool = new FunctionTool({ name: 'test', description: 'Test', inputSchema: {}, callback: () => 'ok' })
    const error = new Error('test error')
    const stopData = { message, stopReason: 'endTurn' as const }
    const streamEvent = {
      type: 'modelContentBlockDeltaEvent' as const,
      delta: { type: 'textDelta' as const, text: 'Hi' },
    }
    const contentBlock = new TextBlock('test')
    const toolStreamEvent = new ToolStreamEvent({ data: { progress: 50 } })
    const agentResult = new AgentResult({
      stopReason: 'endTurn',
      lastMessage: message,
      metrics: new AgentMetrics(),
      invocationState: {},
    })

    return [
      { name: 'InitializedEvent', event: new InitializedEvent({ agent }) },
      { name: 'BeforeInvocationEvent', event: new BeforeInvocationEvent({ agent, invocationState: {} }) },
      { name: 'AfterInvocationEvent', event: new AfterInvocationEvent({ agent, invocationState: {} }) },
      {
        name: 'BeforeModelCallEvent',
        event: new BeforeModelCallEvent({
          agent,
          model: agent.model,
          invocationState: {},
          projectedInputTokens: 100,
        }),
      },
      {
        name: 'AfterModelCallEvent',
        event: Object.assign(
          new AfterModelCallEvent({ agent, model: agent.model, attemptCount: 1, stopData, error, invocationState: {} }),
          { retry: true }
        ),
      },
      { name: 'MessageAddedEvent', event: new MessageAddedEvent({ agent, message, invocationState: {} }) },
      {
        name: 'ModelStreamUpdateEvent',
        event: new ModelStreamUpdateEvent({ agent, event: streamEvent, invocationState: {} }),
      },
      { name: 'ContentBlockEvent', event: new ContentBlockEvent({ agent, contentBlock, invocationState: {} }) },
      {
        name: 'ModelMessageEvent',
        event: new ModelMessageEvent({ agent, message, stopReason: 'endTurn', invocationState: {} }),
      },
      { name: 'ToolResultEvent', event: new ToolResultEvent({ agent, result, invocationState: {} }) },
      {
        name: 'ToolStreamUpdateEvent',
        event: new ToolStreamUpdateEvent({ agent, event: toolStreamEvent, invocationState: {} }),
      },
      { name: 'AgentResultEvent', event: new AgentResultEvent({ agent, result: agentResult, invocationState: {} }) },
      { name: 'BeforeToolCallEvent', event: new BeforeToolCallEvent({ agent, toolUse, tool, invocationState: {} }) },
      {
        name: 'AfterToolCallEvent',
        event: Object.assign(new AfterToolCallEvent({ agent, toolUse, tool, result, error, invocationState: {} }), {
          retry: true,
        }),
      },
      { name: 'BeforeToolsEvent', event: new BeforeToolsEvent({ agent, message, invocationState: {} }) },
      { name: 'AfterToolsEvent', event: new AfterToolsEvent({ agent, message, invocationState: {} }) },
    ]
  }

  const eventInstances = createEventInstances()

  it.each(eventInstances)('$name: toJSON() includes all fields except known exclusions', ({ event }) => {
    const instanceKeys = new Set(Object.keys(event))
    const jsonKeys = new Set(Object.keys(event.toJSON()))

    // Every instance key should either be in JSON output, in the exclusion set, or transformed
    for (const key of instanceKeys) {
      if (!jsonKeys.has(key) && !TRANSFORMED_FIELDS.has(key)) {
        expect(EXCLUDED_FIELDS).toContain(key)
      }
    }

    // Every JSON key should come from the instance or be a known transformation
    for (const key of jsonKeys) {
      expect(instanceKeys.has(key) || TRANSFORMED_FIELDS.has(key)).toBe(true)
    }
  })

  it.each(eventInstances)('$name: toJSON() never includes agent', ({ event }) => {
    const json = event.toJSON()
    expect(json).not.toHaveProperty('agent')
  })
})
