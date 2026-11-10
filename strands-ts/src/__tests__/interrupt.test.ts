import { describe, expect, it } from 'vitest'
import {
  Interrupt,
  InterruptError,
  InterruptState,
  interruptFromAgent,
  type PendingToolExecution,
} from '../interrupt.js'
import { InterruptResponseContent } from '../types/interrupt.js'
import { ToolResultBlock } from '../types/messages.js'
import { SessionError } from '../errors.js'
import { anyTrackingId } from '../__fixtures__/message-helpers.js'

const pendingToolExecution: PendingToolExecution = {
  assistantMessageData: {
    role: 'assistant',
    content: [
      { toolUse: { name: 'tool', toolUseId: 't-0', input: {} } },
      { toolUse: { name: 'tool', toolUseId: 't-1', input: {} } },
    ],
  },
  completedToolResults: {
    't-0': { toolResult: { toolUseId: 't-0', status: 'success', content: [] } },
  },
}

describe('Interrupt', () => {
  it('constructs with all fields and supports response mutation', () => {
    const interrupt = new Interrupt({
      id: 'int-1',
      name: 'confirm_action',
      reason: 'Please confirm',
      response: 'approved',
    })

    expect(interrupt).toEqual({
      id: 'int-1',
      name: 'confirm_action',
      reason: 'Please confirm',
      response: 'approved',
      source: 'hook',
    })

    // response is mutable after construction
    interrupt.response = 'changed'
    expect(interrupt.response).toBe('changed')
  })

  it('round-trips through JSON serialization with complex data', () => {
    const original = new Interrupt({
      id: 'int-1',
      name: 'test',
      reason: { complex: { nested: 'data' } },
      response: ['array', 'response'],
    })

    const serialized = JSON.stringify(original)
    const deserialized = Interrupt.fromJSON(JSON.parse(serialized))

    expect(deserialized).toEqual(original)
  })

  it('omits undefined reason/response from toJSON', () => {
    const interrupt = new Interrupt({ id: 'int-1', name: 'test' })

    const json = interrupt.toJSON()
    expect(json).toStrictEqual({ id: 'int-1', name: 'test', source: 'hook' })
    expect('reason' in json).toBe(false)
    expect('response' in json).toBe(false)
  })
})

describe('InterruptError', () => {
  it('creates catchable error with single interrupt', () => {
    const interrupt = new Interrupt({ id: 'int-1', name: 'confirm_delete' })
    const error = new InterruptError(interrupt)

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'InterruptError',
      message: 'Interrupt raised: confirm_delete',
      interrupts: [interrupt],
    })
  })

  it('creates error with multiple interrupts', () => {
    const a = new Interrupt({ id: 'int-1', name: 'security_check' })
    const b = new Interrupt({ id: 'int-2', name: 'budget_check' })
    const error = new InterruptError([a, b])

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'InterruptError',
      message: '2 interrupts raised: security_check, budget_check',
      interrupts: [a, b],
    })
  })
})

describe('InterruptState', () => {
  describe('getOrCreateInterrupt', () => {
    it('creates new interrupt and stores it', () => {
      const state = new InterruptState()

      const interrupt = state.getOrCreateInterrupt('int-1', 'test', 'reason')

      expect(interrupt).toEqual({ id: 'int-1', name: 'test', reason: 'reason', source: 'hook' })
      expect(state.interrupts['int-1']).toBe(interrupt)
      expect(state.getInterruptsList()).toStrictEqual([interrupt])
    })

    it('returns existing interrupt by ID without overwriting', () => {
      const state = new InterruptState()
      const first = state.getOrCreateInterrupt('int-1', 'test', 'reason')
      first.response = 'user response'

      const second = state.getOrCreateInterrupt('int-1', 'different', 'different reason')

      expect(second).toBe(first)
      expect(second.response).toBe('user response')
    })

    it('creates separate interrupts for different IDs with same name', () => {
      const state = new InterruptState()
      state.activate()
      const first = state.getOrCreateInterrupt('tool:tool-1:0:confirm', 'confirm', 'reason')
      first.response = { approved: true }

      const second = state.getOrCreateInterrupt('tool:tool-2:0:confirm', 'confirm', 'reason')

      expect(second).not.toBe(first)
      expect(second.id).toBe('tool:tool-2:0:confirm')
      expect(second.response).toBeUndefined()
    })

    it('creates interrupt with preemptive response', () => {
      const state = new InterruptState()
      const interrupt = state.getOrCreateInterrupt('int-1', 'confirm', 'reason', 'pre-approved')

      expect(interrupt).toEqual({
        id: 'int-1',
        name: 'confirm',
        reason: 'reason',
        response: 'pre-approved',
        source: 'hook',
      })
    })

    it('ignores preemptive response when interrupt already exists', () => {
      const state = new InterruptState()
      const first = state.getOrCreateInterrupt('int-1', 'confirm', 'reason')
      first.response = 'user response'

      const second = state.getOrCreateInterrupt('int-1', 'confirm', 'reason', 'preemptive')

      expect(second).toBe(first)
      expect(second).toEqual({
        id: 'int-1',
        name: 'confirm',
        reason: 'reason',
        response: 'user response',
        source: 'hook',
      })
    })
  })

  describe('activate / deactivate', () => {
    it('deactivate clears all state', () => {
      const state = new InterruptState()
      state.getOrCreateInterrupt('int-1', 'test')
      state.activate()
      expect(state.activated).toBe(true)

      state.deactivate()

      expect(state).toMatchObject({
        interrupts: {},
        resumeResponses: undefined,
        activated: false,
      })
    })
  })

  describe('resume', () => {
    it('does nothing when not activated', () => {
      const state = new InterruptState()
      state.getOrCreateInterrupt('int-1', 'test')

      state.resume([new InterruptResponseContent({ interruptId: 'int-1', response: 'yes' })])

      expect(state.interrupts['int-1']!.response).toBeUndefined()
    })

    it('populates interrupt responses and stores resumeResponses when activated', () => {
      const state = new InterruptState()
      state.getOrCreateInterrupt('int-1', 'first')
      state.getOrCreateInterrupt('int-2', 'second')
      state.activate()

      const responses = [
        new InterruptResponseContent({ interruptId: 'int-1', response: 'response1' }),
        new InterruptResponseContent({ interruptId: 'int-2', response: { complex: 'data' } }),
      ]
      state.resume(responses)

      expect(state.interrupts['int-1']).toMatchObject({ response: 'response1' })
      expect(state.interrupts['int-2']).toMatchObject({ response: { complex: 'data' } })
      expect(state.resumeResponses).toBe(responses)
    })

    it('throws error for unknown interrupt ID', () => {
      const state = new InterruptState()
      state.getOrCreateInterrupt('int-1', 'test')
      state.activate()

      expect(() => {
        state.resume([new InterruptResponseContent({ interruptId: 'unknown', response: 'yes' })])
      }).toThrow('interrupt_id=<unknown> | no interrupt found')
    })
  })

  describe('serialization', () => {
    it('round-trips through JSON with full state', () => {
      const original = new InterruptState()
      original.getOrCreateInterrupt('int-1', 'test', { complex: 'reason' })
      original.interrupts['int-1']!.response = ['array', 'response']
      original.activate()

      const serialized = JSON.stringify(original)
      const deserialized = InterruptState.fromJSON(JSON.parse(serialized))

      expect(deserialized.toJSON()).toStrictEqual(original.toJSON())
    })

    it('round-trips pendingToolExecution through JSON', () => {
      const original = new InterruptState()
      original.getOrCreateInterrupt('int-1', 'test')
      original.activate()
      original.setPendingToolExecution(pendingToolExecution)

      const serialized = JSON.stringify(original)
      const deserialized = InterruptState.fromJSON(JSON.parse(serialized))

      expect(deserialized.toJSON()).toStrictEqual(original.toJSON())
      expect(deserialized.pendingToolExecution).toStrictEqual(original.pendingToolExecution)
    })

    it('deserializes state with resumeResponses', () => {
      const state = InterruptState.fromJSON({
        interrupts: {
          'int-1': { id: 'int-1', name: 'test', reason: 'reason', response: 'yes' },
        },
        resumeResponses: [{ interruptResponse: { interruptId: 'int-1', response: 'yes' } }],
        activated: true,
      })

      expect(state).toMatchObject({
        activated: true,
        interrupts: {
          'int-1': { id: 'int-1', name: 'test', reason: 'reason', response: 'yes' },
        },
        resumeResponses: [{ interruptResponse: { interruptId: 'int-1', response: 'yes' } }],
      })
    })

    it('drops a pending tool execution when the interrupt state is not activated', () => {
      const state = InterruptState.fromJSON({ interrupts: {}, activated: false, pendingToolExecution })

      expect(state.pendingToolExecution).toBeUndefined()
    })

    it.each([
      {
        description: 'a non-assistant message',
        pending: {
          ...pendingToolExecution,
          assistantMessageData: { ...pendingToolExecution.assistantMessageData, role: 'user' },
        },
        message: 'field=<pendingToolExecution.assistantMessageData.role>',
      },
      {
        description: 'an unparseable message',
        pending: { ...pendingToolExecution, assistantMessageData: { role: 'assistant', content: 'not-a-list' } },
        message: 'field=<pendingToolExecution.assistantMessageData>',
      },
      {
        description: 'a message without tool uses',
        pending: {
          assistantMessageData: { role: 'assistant', content: [{ text: 'hello' }] },
          completedToolResults: {},
        },
        message: 'field=<pendingToolExecution.assistantMessageData.content>',
      },
      {
        description: 'non-object completed tool results',
        pending: { ...pendingToolExecution, completedToolResults: ['t-0'] },
        message: 'field=<pendingToolExecution.completedToolResults>',
      },
      {
        description: 'a completed tool result for an unknown tool use',
        pending: {
          ...pendingToolExecution,
          completedToolResults: { 't-9': { toolResult: { toolUseId: 't-9', status: 'success', content: [] } } },
        },
        message: 'field=<pendingToolExecution.completedToolResults>, tool_use_id=<t-9>',
      },
      {
        description: 'an unparseable completed tool result',
        pending: { ...pendingToolExecution, completedToolResults: { 't-0': { toolResult: { toolUseId: 't-0' } } } },
        message: 'field=<pendingToolExecution.completedToolResults>, tool_use_id=<t-0>',
      },
    ])('throws SessionError when the restored pending tool execution has $description', ({ pending, message }) => {
      const restore = (): InterruptState =>
        InterruptState.fromJSON({
          interrupts: {},
          activated: true,
          pendingToolExecution: pending as unknown as PendingToolExecution,
        })

      expect(restore).toThrow(SessionError)
      expect(restore).toThrow(message)
    })

    it('keeps the parse error as the cause when the restored pending assistant message is unparseable', () => {
      const restore = (): InterruptState =>
        InterruptState.fromJSON({
          interrupts: {},
          activated: true,
          pendingToolExecution: {
            assistantMessageData: { role: 'assistant', content: 'not-a-list' },
            completedToolResults: {},
          } as unknown as PendingToolExecution,
        })

      expect(restore).toThrow(expect.objectContaining({ name: 'SessionError', cause: expect.any(TypeError) }))
    })
  })

  describe('getPendingExecution', () => {
    it('returns undefined when the interrupt state is not activated', () => {
      const state = new InterruptState()
      state.setPendingToolExecution(pendingToolExecution)

      expect(state.getPendingExecution()).toBeUndefined()
    })

    it('returns the reconstructed pending execution when the interrupt state is activated', () => {
      const state = new InterruptState()
      state.activate()
      state.setPendingToolExecution(pendingToolExecution)

      const pending = state.getPendingExecution()

      expect(pending?.assistantMessage.toJSON()).toEqual({
        ...pendingToolExecution.assistantMessageData,
        trackingId: anyTrackingId,
      })
      expect(pending?.completedToolResults).toEqual(
        new Map([['t-0', ToolResultBlock.fromJSON(pendingToolExecution.completedToolResults['t-0']!)]])
      )
    })
  })
})

describe('interruptFromAgent', () => {
  // Minimal agent-like object with _interruptState
  function createMockAgent(state: InterruptState) {
    return { _interruptState: state } as unknown as import('../types/agent.js').LocalAgent
  }

  it('returns preemptive response immediately without throwing', () => {
    const state = new InterruptState()
    const agent = createMockAgent(state)

    const result = interruptFromAgent(
      agent,
      'test-id',
      {
        name: 'confirm',
        reason: 'need approval',
        response: 'pre-approved',
      },
      'tool'
    )

    expect(result).toBe('pre-approved')
    expect(state.interrupts['test-id']).toMatchObject({
      id: 'test-id',
      name: 'confirm',
      reason: 'need approval',
      response: 'pre-approved',
      source: 'tool',
    })
  })

  it('returns resume response over preemptive response for existing interrupt', () => {
    const state = new InterruptState()
    state.getOrCreateInterrupt('test-id', 'confirm', 'need approval')
    state.interrupts['test-id']!.response = 'user-provided'

    const agent = createMockAgent(state)

    const result = interruptFromAgent(
      agent,
      'test-id',
      {
        name: 'confirm',
        reason: 'need approval',
        response: 'preemptive',
      },
      'tool'
    )

    expect(result).toBe('user-provided')
    expect(state.interrupts['test-id']).toMatchObject({
      id: 'test-id',
      name: 'confirm',
      reason: 'need approval',
      response: 'user-provided',
    })
  })

  it('does not interrupt when preemptive response is null', () => {
    const state = new InterruptState()
    const agent = createMockAgent(state)

    const result = interruptFromAgent(
      agent,
      'test-id',
      {
        name: 'confirm',
        response: null,
      },
      'tool'
    )

    expect(result).toBeNull()
    expect(state.interrupts['test-id']).toMatchObject({
      id: 'test-id',
      name: 'confirm',
      response: null,
      source: 'tool',
    })
  })
})
