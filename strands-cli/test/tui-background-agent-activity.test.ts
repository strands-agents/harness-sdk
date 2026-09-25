import { describe, expect, it, vi } from 'vitest'
import {
  TextBlock,
  ToolResultBlock,
  type Agent,
  type AgentStreamEvent,
  type BeforeModelCallEvent,
  type LocalAgent,
  type Tool,
  type ToolContext,
  type ToolStreamEvent,
} from '@strands-agents/sdk'

import { BackgroundAgentActivityStore, observeSubagentActivity } from '../src/tui/background/activity.js'
import { BackgroundAgentInbox } from '../src/tui/background/inbox.js'
import { LiveSteering } from '../src/tui/steering.js'

describe('BackgroundAgentActivityStore', () => {
  it('observes subagent tool progress and restores the original stream', async () => {
    const childEvent = {
      type: 'modelStreamUpdateEvent',
      event: {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Review complete.' },
      },
    } as AgentStreamEvent
    const originalStream = async function* (): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
      yield { type: 'toolStreamEvent', data: childEvent } as ToolStreamEvent
      return new ToolResultBlock({
        toolUseId: 'generalist-0',
        status: 'success',
        content: [new TextBlock('done')],
      })
    }
    const subagent = {
      name: 'subagent',
      description: 'delegate',
      toolSpec: { name: 'subagent', description: 'delegate' },
      stream: originalStream,
    } as Tool
    const context = {
      toolUse: {
        name: 'subagent',
        toolUseId: 'generalist-0',
        input: { task: 'Review authentication.' },
      },
      agent: {} as Agent,
      invocationState: {},
      cancelSignal: new AbortController().signal,
      interrupt: () => {},
    } as ToolContext
    const store = new BackgroundAgentActivityStore()
    const stop = observeSubagentActivity(subagent, store)
    const stream = subagent.stream(context)

    await stream.next()
    store.linkTask('task-0', 'generalist-0')
    await stream.next()

    expect(store.get('task-0')).toMatchObject({
      name: 'subagent',
      task: 'Review authentication.',
      status: 'completed',
      entries: [{ type: 'assistant', text: 'Review complete.' }],
    })

    stop()
    expect(subagent.stream).toBe(originalStream)
  })

  it('associates a dynamically created subagent with its background task inbox', async () => {
    const inbox = new BackgroundAgentInbox()
    const store = new BackgroundAgentActivityStore(inbox)
    const endpointEvents: unknown[] = []
    inbox.subscribe((event) => endpointEvents.push(event))
    const steering: LiveSteering = new LiveSteering((agent) => {
      return inbox.observeAgent((prompt) => steering.enqueue(agent, prompt))
    })
    const child = {
      messages: [],
      addHook() {},
    } as unknown as LocalAgent
    const originalStream = async function* (): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
      steering.observeAgent(child)
      yield { type: 'toolStreamEvent' } as ToolStreamEvent
      return new ToolResultBlock({
        toolUseId: 'generalist-0',
        status: 'success',
        content: [new TextBlock('done')],
      })
    }
    const subagent = {
      name: 'subagent',
      description: 'delegate',
      toolSpec: { name: 'subagent', description: 'delegate' },
      stream: originalStream,
    } as Tool
    const context = {
      toolUse: {
        name: 'subagent',
        toolUseId: 'generalist-0',
        input: { task: 'Review authentication.' },
      },
      agent: {} as Agent,
      invocationState: {},
      cancelSignal: new AbortController().signal,
      interrupt: () => {},
    } as ToolContext
    store.linkTask('task-0', 'generalist-0')
    observeSubagentActivity(subagent, store)
    const stream = subagent.stream(context)

    await stream.next()

    expect(endpointEvents).toEqual([
      {
        type: 'available',
        endpoint: {
          taskId: 'task-0',
          name: 'subagent',
          task: 'Review authentication.',
        },
      },
    ])
    expect(inbox.send('task-0', 'Check authorization tests.')).toBe(true)
    const event = { agent: child } as unknown as BeforeModelCallEvent
    const action = steering.beforeModelCall(event)
    expect(action.type).toBe('transform')
    if (action.type === 'transform') {
      action.apply(event)
    }
    expect(child.messages).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'textBlock', text: 'Check authorization tests.' }],
      },
    ])

    await stream.next()

    expect(endpointEvents.at(-1)).toEqual({ type: 'unavailable', taskId: 'task-0' })
    expect(inbox.send('task-0', 'Too late.')).toBe(false)
  })

  it('projects a subagent child stream and publishes linked task updates', () => {
    const store = new BackgroundAgentActivityStore()
    const listener = vi.fn()

    store.onStart({
      name: 'subagent',
      task: 'Review authentication.',
      toolUseId: 'generalist-1',
    })
    store.linkTask('task-1', 'generalist-1')
    const unsubscribe = store.subscribe('task-1', listener)

    store.onEvent({
      toolUseId: 'generalist-1',
      event: {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'reasoningContentDelta', text: 'Checking ' },
        },
      } as AgentStreamEvent,
    })
    store.onEvent({
      toolUseId: 'generalist-1',
      event: {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'reasoningContentDelta', text: 'the flow.' },
        },
      } as AgentStreamEvent,
    })
    store.onEvent({
      toolUseId: 'generalist-1',
      event: {
        type: 'beforeToolCallEvent',
        toolUse: { toolUseId: 'child-tool-1', name: 'read', input: { path: 'auth.ts' } },
      } as unknown as AgentStreamEvent,
    })
    store.onEvent({
      toolUseId: 'generalist-1',
      event: {
        type: 'toolResultEvent',
        result: {
          toolUseId: 'child-tool-1',
          status: 'success',
          content: [{ type: 'textBlock', text: 'source' }],
        },
      } as AgentStreamEvent,
    })
    store.onEvent({
      toolUseId: 'generalist-1',
      event: {
        type: 'modelStreamUpdateEvent',
        event: {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'No issue found.' },
        },
      } as AgentStreamEvent,
    })
    store.onComplete({
      toolUseId: 'generalist-1',
    })

    expect(store.get('task-1')).toEqual({
      toolUseId: 'generalist-1',
      taskId: 'task-1',
      name: 'subagent',
      task: 'Review authentication.',
      status: 'completed',
      entries: [
        { type: 'reasoning', text: 'Checking the flow.' },
        {
          type: 'tool',
          toolUseId: 'child-tool-1',
          name: 'read',
          input: { path: 'auth.ts' },
          status: 'success',
          result: 'source',
        },
        { type: 'assistant', text: 'No issue found.' },
      ],
    })
    expect(listener).toHaveBeenCalled()

    const callsBeforeUnsubscribe = listener.mock.calls.length
    unsubscribe()
    store.onError({
      toolUseId: 'generalist-1',
      error: new Error('late failure'),
    })
    expect(listener).toHaveBeenCalledTimes(callsBeforeUnsubscribe)
  })

  it('notifies a task linked before its subagent starts', () => {
    const store = new BackgroundAgentActivityStore()
    const listener = vi.fn()
    store.linkTask('task-3', 'generalist-3', 'working')
    store.subscribe('task-3', listener)

    store.onStart({
      name: 'subagent',
      task: 'Research the issue.',
      toolUseId: 'generalist-3',
    })

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        taskId: 'task-3',
        toolUseId: 'generalist-3',
        name: 'subagent',
      })
    )
  })

  it('sanitizes subagent metadata, nested tool input, and result text', () => {
    const store = new BackgroundAgentActivityStore()
    store.onStart({
      name: 'general\u001b[31mist',
      task: 'line\tone\nline\u0007two',
      toolUseId: 'generalist\u0007-5',
    })
    store.linkTask('task\u009b31m-5', 'generalist\u0007-5')
    store.onEvent({
      toolUseId: 'generalist\u0007-5',
      event: {
        type: 'beforeToolCallEvent',
        toolUse: {
          toolUseId: 'child\u0007-1',
          name: 're\u001b[2Jad',
          input: { '\u009b31mkey': 'value\u0007' },
        },
      } as unknown as AgentStreamEvent,
    })
    store.onEvent({
      toolUseId: 'generalist\u0007-5',
      event: {
        type: 'toolResultEvent',
        result: {
          toolUseId: 'child\u0007-1',
          status: 'success',
          content: [{ type: 'textBlock', text: 'before\u001b]52;c;x\u0007after' }],
        },
      } as AgentStreamEvent,
    })

    expect(store.get('task\u009b31m-5')).toEqual({
      toolUseId: 'generalist-5',
      taskId: 'task-5',
      name: 'generalist',
      task: 'line\tone\nlinetwo',
      status: 'working',
      entries: [
        {
          type: 'tool',
          toolUseId: 'child-1',
          name: 'read',
          input: { key: 'value' },
          status: 'success',
          result: 'beforeafter',
        },
      ],
    })
  })
})
