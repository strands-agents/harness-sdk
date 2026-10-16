import { describe, it, expect, vi } from 'vitest'
import { stop, makeStop } from '../index.js'
import { DEFAULT_STOP_MESSAGE, DEFAULT_MAX_STOP_MESSAGE_LENGTH } from '../types.js'
import type { ToolContext } from '../../../../index.js'
import { createMockAgent } from '../../../../__fixtures__/agent-helpers.js'

const createFreshContext = (): { cancel: ReturnType<typeof vi.fn>; context: ToolContext } => {
  const cancel = vi.fn()
  const agent = createMockAgent({ extra: { cancel } })
  const context: ToolContext = {
    toolUse: { name: 'stop', toolUseId: 'test-id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: agent.cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  }
  return { cancel, context }
}

describe('stop tool', () => {
  describe('behavior', () => {
    it('returns the provided message verbatim', async () => {
      const { context } = createFreshContext()
      const result = await stop.invoke({ message: 'all done' }, context)
      expect(result).toBe('all done')
    })

    it('returns the default message when none is provided', async () => {
      const { context } = createFreshContext()
      const result = await stop.invoke({}, context)
      expect(result).toBe(DEFAULT_STOP_MESSAGE)
    })

    it('defers the cancellation so sibling tools in the batch still run', async () => {
      const { cancel, context } = createFreshContext()
      await stop.invoke({ message: 'finished' }, context)

      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledWith({ message: 'finished', afterCurrentTools: true })
    })

    it('cancels with the default message when none is provided', async () => {
      const { cancel, context } = createFreshContext()
      await stop.invoke({}, context)

      expect(cancel).toHaveBeenCalledWith({ message: DEFAULT_STOP_MESSAGE, afterCurrentTools: true })
    })

    it('falls back to the default when message is an empty string, so the loop still has a final message', async () => {
      const { cancel, context } = createFreshContext()
      const result = await stop.invoke({ message: '' }, context)

      expect(result).toBe(DEFAULT_STOP_MESSAGE)
      expect(cancel).toHaveBeenCalledWith({ message: DEFAULT_STOP_MESSAGE, afterCurrentTools: true })
    })

    it('falls back to the default when message is null, so providers that serialize omitted fields as null still halt', async () => {
      // Some providers serialize an omitted optional field as JSON null rather
      // than absent; the schema must accept null and the callback must treat
      // it identically to undefined.
      const { cancel, context } = createFreshContext()
      const result = await stop.invoke({ message: null as unknown as string }, context)

      expect(result).toBe(DEFAULT_STOP_MESSAGE)
      expect(cancel).toHaveBeenCalledWith({ message: DEFAULT_STOP_MESSAGE, afterCurrentTools: true })
    })
  })

  describe('input validation', () => {
    it('rejects an oversized message', async () => {
      const { context } = createFreshContext()
      const oversized = 'x'.repeat(DEFAULT_MAX_STOP_MESSAGE_LENGTH + 1)
      await expect(stop.invoke({ message: oversized }, context)).rejects.toThrow(/maximum/i)
    })

    it('accepts a message at the length cap', async () => {
      const { context } = createFreshContext()
      const atCap = 'x'.repeat(DEFAULT_MAX_STOP_MESSAGE_LENGTH)
      const result = await stop.invoke({ message: atCap }, context)
      expect(result).toBe(atCap)
    })

    it('rejects a non-string message', async () => {
      const { context } = createFreshContext()
      await expect(stop.invoke({ message: 123 as unknown as string }, context)).rejects.toThrow()
    })

    it('does not cancel the agent when validation fails', async () => {
      const { cancel, context } = createFreshContext()
      const oversized = 'x'.repeat(DEFAULT_MAX_STOP_MESSAGE_LENGTH + 1)
      await expect(stop.invoke({ message: oversized }, context)).rejects.toThrow()
      expect(cancel).not.toHaveBeenCalled()
    })

    it('throws when invoked without a tool context', async () => {
      await expect(stop.invoke({})).rejects.toThrow(/context is required/i)
    })

    it('relaxes the cap when maxMessageLength is configured', async () => {
      const { context } = createFreshContext()
      const bigStop = makeStop({ maxMessageLength: 10_000 })
      const message = 'x'.repeat(8000)
      const result = await bigStop.invoke({ message }, context)
      expect(result).toBe(message)
    })

    it('still enforces the configured cap when it is exceeded', async () => {
      const { context } = createFreshContext()
      const bigStop = makeStop({ maxMessageLength: 10_000 })
      await expect(bigStop.invoke({ message: 'x'.repeat(10_001) }, context)).rejects.toThrow(/maximum of 10000/)
    })

    it('rejects a non-positive maxMessageLength at factory time', () => {
      expect(() => makeStop({ maxMessageLength: 0 })).toThrow(/positive integer/)
      expect(() => makeStop({ maxMessageLength: -1 })).toThrow(/positive integer/)
      expect(() => makeStop({ maxMessageLength: 1.5 })).toThrow(/positive integer/)
    })
  })

  describe('metadata', () => {
    it('supports a custom name', () => {
      const finish = makeStop({ name: 'finish' })
      expect(finish.name).toBe('finish')
    })

    it('supports a custom description', () => {
      const custom = makeStop({ description: 'custom desc' })
      expect(custom.description).toBe('custom desc')
    })

    it('exposes message as an optional property in the tool spec', () => {
      const schema = stop.toolSpec.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(schema.properties).toHaveProperty('message')
      expect(schema.required ?? []).not.toContain('message')
    })
  })
})
