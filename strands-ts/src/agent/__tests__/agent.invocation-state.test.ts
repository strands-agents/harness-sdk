import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  MessageAddedEvent,
} from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { ToolResultBlock, TextBlock } from '../../types/messages.js'
import type { InvocationState } from '../../types/agent.js'

describe('invocationState', () => {
  describe('round-trip', () => {
    it('returns an empty object on AgentResult when no invocationState is passed', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      const result = await agent.invoke('Hi')

      expect(result.invocationState).toEqual({})
    })

    it('returns the passed invocationState on AgentResult', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      const result = await agent.invoke('Hi', { invocationState: { userId: 'u-1', traceId: 't-1' } })

      expect(result.invocationState).toEqual({ userId: 'u-1', traceId: 't-1' })
    })

    it('preserves reference identity: caller keeps the same object they passed in', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      const state: InvocationState = { userId: 'u-1' }
      const result = await agent.invoke('Hi', { invocationState: state })

      expect(result.invocationState).toBe(state)
    })
  })

  describe('hook mutation', () => {
    it('propagates mutations from BeforeModelCallEvent to AfterModelCallEvent and AgentResult', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      let seenInAfter: InvocationState | undefined
      agent.addHook(BeforeModelCallEvent, (event) => {
        event.invocationState.counter = (event.invocationState.counter as number | undefined) ?? 0
        event.invocationState.counter = (event.invocationState.counter as number) + 1
      })
      agent.addHook(AfterModelCallEvent, (event) => {
        seenInAfter = event.invocationState
      })

      const result = await agent.invoke('Hi')

      expect(seenInAfter).toEqual({ counter: 1 })
      expect(result.invocationState).toEqual({ counter: 1 })
    })

    it('shares the same invocationState object across all lifecycle events in one invocation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      const seen: InvocationState[] = []
      const collect = (event: { invocationState: InvocationState }): void => {
        seen.push(event.invocationState)
      }

      agent.addHook(BeforeInvocationEvent, collect)
      agent.addHook(BeforeModelCallEvent, collect)
      agent.addHook(AfterModelCallEvent, collect)
      agent.addHook(MessageAddedEvent, collect)
      agent.addHook(AfterInvocationEvent, collect)

      const result = await agent.invoke('Hi')

      // Every hook, plus the result, sees the same reference.
      expect(seen.length).toBeGreaterThan(0)
      for (const observed of seen) {
        expect(observed).toBe(result.invocationState)
      }
    })
  })

  describe('multi-cycle persistence', () => {
    it('persists mutations across recursive agent loop cycles (tool-use scenario)', async () => {
      const tool = createMockTool(
        'ping',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('pong')],
          })
      )

      const model = new MockMessageModel()
        .addTurn([{ type: 'toolUseBlock', name: 'ping', toolUseId: 'tool-1', input: {} }])
        .addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model, tools: [tool] })

      // Write in AfterToolCallEvent during cycle 1; read in BeforeModelCallEvent during cycle 2.
      let cycle2State: InvocationState | undefined
      let modelCalls = 0
      agent.addHook(AfterToolCallEvent, (event) => {
        event.invocationState.toolCompleted = true
      })
      agent.addHook(BeforeModelCallEvent, (event) => {
        modelCalls++
        if (modelCalls === 2) {
          cycle2State = event.invocationState
        }
      })

      const result = await agent.invoke('Run ping')

      expect(modelCalls).toBe(2)
      expect(cycle2State).toEqual({ toolCompleted: true })
      expect(result.invocationState).toEqual({ toolCompleted: true })
    })
  })

  describe('tool access', () => {
    it('passes invocationState to tools via ToolContext and surfaces mutations on the result', async () => {
      const tool = createMockTool('writer', () => {
        throw new Error('unused')
      })
      // Override stream to read/write invocationState.
      // eslint-disable-next-line require-yield
      tool.stream = async function* (context) {
        const prev = (context.invocationState.callCount as number | undefined) ?? 0
        context.invocationState.callCount = prev + 1
        context.invocationState.lastToolSeenUserId = context.invocationState.userId
        return new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'success',
          content: [new TextBlock('ok')],
        })
      }

      const model = new MockMessageModel()
        .addTurn([{ type: 'toolUseBlock', name: 'writer', toolUseId: 'tu-1', input: {} }])
        .addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model, tools: [tool] })

      const result = await agent.invoke('Run writer', { invocationState: { userId: 'u-42' } })

      expect(result.invocationState).toEqual({
        userId: 'u-42',
        callCount: 1,
        lastToolSeenUserId: 'u-42',
      })
    })
  })

  describe('isolation from appState', () => {
    it('does not touch agent.appState when invocationState is mutated', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, appState: { persistent: 'yes' } })

      agent.addHook(BeforeModelCallEvent, (event) => {
        event.invocationState.ephemeral = 'only-this-run'
      })

      const result = await agent.invoke('Hi', { invocationState: { requestId: 'r-1' } })

      expect(result.invocationState).toEqual({ requestId: 'r-1', ephemeral: 'only-this-run' })
      expect(agent.appState.get('persistent')).toBe('yes')
      expect(agent.appState.get('ephemeral')).toBeUndefined()
      expect(agent.appState.get('requestId')).toBeUndefined()
    })
  })

  describe('across invocations', () => {
    it('does not leak state between invocations on the same agent (default bag)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'A' })
        .addTurn({ type: 'textBlock', text: 'B' })
      const agent = new Agent({ model })

      agent.addHook(BeforeModelCallEvent, (event) => {
        event.invocationState.seen = true
      })

      const first = await agent.invoke('1')
      const second = await agent.invoke('2')

      expect(first.invocationState).toEqual({ seen: true })
      expect(second.invocationState).toEqual({ seen: true })
      expect(first.invocationState).not.toBe(second.invocationState)
    })
  })

  describe('retry paths', () => {
    it('preserves same invocationState reference across AfterModelCallEvent retry', async () => {
      const model = new MockMessageModel()
        .addTurn(new Error('transient failure'))
        .addTurn({ type: 'textBlock', text: 'Success after retry' })
      const agent = new Agent({ model, printer: false })

      let retried = false
      const seen: InvocationState[] = []

      agent.addHook(BeforeModelCallEvent, (event) => {
        seen.push(event.invocationState)
        event.invocationState.modelCalls = (event.invocationState.modelCalls as number | undefined) ?? 0
        event.invocationState.modelCalls = (event.invocationState.modelCalls as number) + 1
      })
      agent.addHook(AfterModelCallEvent, (event) => {
        seen.push(event.invocationState)
        if (!retried && event.error) {
          retried = true
          event.retry = true
        }
      })

      const result = await agent.invoke('Test', { invocationState: { userId: 'u-1' } })

      // Retry path was exercised: two Before + two After observations.
      expect(seen.length).toBe(4)
      // Every observation is the same object the caller passed in.
      for (const observed of seen) {
        expect(observed).toBe(result.invocationState)
      }
      // Mutations from the first attempt survive into the retry.
      expect(result.invocationState).toEqual({ userId: 'u-1', modelCalls: 2 })
    })

    it('preserves same invocationState reference across AfterToolCallEvent retry', async () => {
      let toolCalls = 0
      const tool = createMockTool('flaky', () => {
        toolCalls++
        return new ToolResultBlock({
          toolUseId: 'tu-1',
          status: toolCalls === 1 ? 'error' : 'success',
          content: [new TextBlock(toolCalls === 1 ? 'fail' : 'ok')],
        })
      })

      const model = new MockMessageModel()
        .addTurn([{ type: 'toolUseBlock', name: 'flaky', toolUseId: 'tu-1', input: {} }])
        .addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model, tools: [tool], printer: false })

      let retried = false
      const seen: InvocationState[] = []

      agent.addHook(AfterToolCallEvent, (event) => {
        seen.push(event.invocationState)
        event.invocationState.toolAttempts = (event.invocationState.toolAttempts as number | undefined) ?? 0
        event.invocationState.toolAttempts = (event.invocationState.toolAttempts as number) + 1
        if (!retried && event.result.status === 'error') {
          retried = true
          event.retry = true
        }
      })

      const result = await agent.invoke('Run flaky', { invocationState: { requestId: 'r-1' } })

      // Retry fired twice: failed attempt + successful attempt.
      expect(toolCalls).toBe(2)
      expect(seen.length).toBe(2)
      for (const observed of seen) {
        expect(observed).toBe(result.invocationState)
      }
      expect(result.invocationState).toEqual({ requestId: 'r-1', toolAttempts: 2 })
    })
  })
})
