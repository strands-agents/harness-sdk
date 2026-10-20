import { describe, expect, it } from 'vitest'

import {
  BidiAfterConnectionRestartEvent,
  BidiAgentStopEvent,
  BidiBargeInEvent,
  BidiBeforeConnectionRestartEvent,
  BidiResponseStopEvent,
} from '../events.js'
import { ConnectionTimeoutError } from '../../models/model.js'
import { HookRegistryImplementation } from '../../../hooks/registry.js'

import type { InvocationState, LocalAgent } from '../../../types/agent.js'

const agent = { id: 'agent-1' } as unknown as LocalAgent
const invocationState: InvocationState = {}

describe('bidi hook events', () => {
  describe('_shouldReverseCallbacks', () => {
    it('reverses callbacks for the stop and after-restart events only', () => {
      expect(new BidiAgentStopEvent({ agent, invocationState })._shouldReverseCallbacks()).toBe(true)
      expect(
        new BidiAfterConnectionRestartEvent({ agent, invocationState, reason: 'scheduled' })._shouldReverseCallbacks()
      ).toBe(true)
      expect(
        new BidiResponseStopEvent({ agent, invocationState, responseId: 'response-1' })._shouldReverseCallbacks()
      ).toBe(false)
      expect(new BidiBargeInEvent({ agent, invocationState })._shouldReverseCallbacks()).toBe(false)
      expect(
        new BidiBeforeConnectionRestartEvent({ agent, invocationState, reason: 'scheduled' })._shouldReverseCallbacks()
      ).toBe(false)
    })
  })

  describe('BidiBargeInEvent', () => {
    it('carries the agent and invocation state and serializes neither', () => {
      const event = new BidiBargeInEvent({ agent, invocationState })

      expect(event.agent).toBe(agent)
      expect(event.invocationState).toBe(invocationState)
      expect(JSON.parse(JSON.stringify(event))).toEqual({ type: 'bidiBargeInEvent' })
    })
  })

  describe('BidiAgentStopEvent', () => {
    it('serializes without the agent reference', () => {
      expect(JSON.parse(JSON.stringify(new BidiAgentStopEvent({ agent, invocationState })))).toEqual({
        type: 'bidiAgentStopEvent',
      })
    })
  })

  describe('BidiResponseStopEvent', () => {
    it('carries and serializes the response id', () => {
      const event = new BidiResponseStopEvent({ agent, invocationState, responseId: 'response-1' })

      expect(event.responseId).toBe('response-1')
      expect(JSON.parse(JSON.stringify(event))).toEqual({
        type: 'bidiResponseStopEvent',
        responseId: 'response-1',
      })
    })
  })

  describe('BidiBeforeConnectionRestartEvent', () => {
    it('omits an absent timeout error', () => {
      const event = new BidiBeforeConnectionRestartEvent({ agent, invocationState, reason: 'scheduled' })

      expect(event.timeoutError).toBeUndefined()
      expect(JSON.parse(JSON.stringify(event))).toEqual({
        type: 'bidiBeforeConnectionRestartEvent',
        reason: 'scheduled',
      })
    })

    it('reduces the timeout error to its message on the reactive path', () => {
      const timeoutError = new ConnectionTimeoutError('connection timed out')
      const event = new BidiBeforeConnectionRestartEvent({
        agent,
        invocationState,
        reason: 'timeout',
        timeoutError,
      })

      expect(event.timeoutError).toBe(timeoutError)
      expect(JSON.parse(JSON.stringify(event))).toEqual({
        type: 'bidiBeforeConnectionRestartEvent',
        reason: 'timeout',
        timeoutError: { message: 'connection timed out' },
      })
    })
  })

  describe('BidiAfterConnectionRestartEvent', () => {
    it('omits an absent error', () => {
      const event = new BidiAfterConnectionRestartEvent({ agent, invocationState, reason: 'timeout' })

      expect(event.error).toBeUndefined()
      expect(JSON.parse(JSON.stringify(event))).toEqual({
        type: 'bidiAfterConnectionRestartEvent',
        reason: 'timeout',
      })
    })

    it('reduces a restart failure to its message', () => {
      const error = new Error('restart failed')
      const event = new BidiAfterConnectionRestartEvent({ agent, invocationState, reason: 'timeout', error })

      expect(event.error).toBe(error)
      expect(JSON.parse(JSON.stringify(event))).toEqual({
        type: 'bidiAfterConnectionRestartEvent',
        reason: 'timeout',
        error: { message: 'restart failed' },
      })
    })
  })

  describe('hook registry dispatch', () => {
    it('delivers each event to callbacks registered for its class', async () => {
      const registry = new HookRegistryImplementation()
      const received: string[] = []

      registry.addCallback(BidiBargeInEvent, (event) => {
        received.push(event.type)
      })
      registry.addCallback(BidiAgentStopEvent, (event) => {
        received.push(event.type)
      })

      await registry.invokeCallbacks(new BidiBargeInEvent({ agent, invocationState }))
      await registry.invokeCallbacks(new BidiAgentStopEvent({ agent, invocationState }))

      expect(received).toEqual(['bidiBargeInEvent', 'bidiAgentStopEvent'])
    })
  })
})
