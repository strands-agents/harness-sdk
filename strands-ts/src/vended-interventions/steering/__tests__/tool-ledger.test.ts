import { describe, expect, it } from 'vitest'
import { Agent } from '../../../agent/agent.js'
import { AfterToolCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import type { HookRegistryImplementation } from '../../../hooks/registry.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { ToolLedgerProvider } from '../providers/tool-ledger.js'

describe('ToolLedgerProvider', () => {
  const toolUse = { name: 'searchWeb', toolUseId: 'tu-1', input: { q: 'hi' } }

  function setupAgent(provider: ToolLedgerProvider): {
    agent: Agent
    hookRegistry: HookRegistryImplementation
  } {
    const agent = new Agent()
    const hookRegistry = (agent as unknown as { _hooksRegistry: HookRegistryImplementation })._hooksRegistry
    provider.observeAgent(agent)
    return { agent, hookRegistry }
  }

  function makeBefore(agent: Agent): BeforeToolCallEvent {
    return new BeforeToolCallEvent({ agent, toolUse, tool: undefined, invocationState: {} })
  }

  function makeAfter(agent: Agent, status: 'success' | 'error' = 'success', error?: Error): AfterToolCallEvent {
    return new AfterToolCallEvent({
      agent,
      toolUse,
      tool: undefined,
      result: new ToolResultBlock({
        toolUseId: toolUse.toolUseId,
        status,
        content: [new TextBlock('result text')],
        ...(error !== undefined && { error }),
      }),
      invocationState: {},
      ...(error !== undefined && { error }),
    })
  }

  it('records pending entry on beforeToolCall', async () => {
    const provider = new ToolLedgerProvider()
    const { agent, hookRegistry } = setupAgent(provider)

    expect(provider.context.type).toBe('toolLedger')
    expect(provider.context.calls).toEqual([])

    await hookRegistry.invokeCallbacks(makeBefore(agent))

    const calls = provider.context.calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 'tu-1',
      name: 'searchWeb',
      args: { q: 'hi' },
      status: 'pending',
    })
  })

  it('flips pending to success after afterToolCall', async () => {
    const provider = new ToolLedgerProvider()
    const { agent, hookRegistry } = setupAgent(provider)

    await hookRegistry.invokeCallbacks(makeBefore(agent))
    await hookRegistry.invokeCallbacks(makeAfter(agent, 'success'))

    const calls = provider.context.calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 'tu-1',
      name: 'searchWeb',
      args: { q: 'hi' },
      status: 'success',
      error: null,
      endTime: expect.any(String),
    })
  })

  it('records error status and message', async () => {
    const provider = new ToolLedgerProvider()
    const { agent, hookRegistry } = setupAgent(provider)

    await hookRegistry.invokeCallbacks(makeBefore(agent))
    await hookRegistry.invokeCallbacks(makeAfter(agent, 'error', new Error('boom')))

    const calls = provider.context.calls as Array<Record<string, unknown>>
    expect(calls[0]).toMatchObject({
      id: 'tu-1',
      name: 'searchWeb',
      args: { q: 'hi' },
      status: 'error',
      error: 'boom',
      endTime: expect.any(String),
    })
  })

  it('drops oldest entries when ledger exceeds maxEntries', async () => {
    const provider = new ToolLedgerProvider({ maxEntries: 2 })
    const { agent, hookRegistry } = setupAgent(provider)

    for (const id of ['a', 'b', 'c']) {
      await hookRegistry.invokeCallbacks(
        new BeforeToolCallEvent({
          agent,
          toolUse: { name: 't', toolUseId: id, input: {} },
          tool: undefined,
          invocationState: {},
        })
      )
    }

    const calls = provider.context.calls as Array<Record<string, unknown>>
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.id)).toEqual(['b', 'c'])
  })
})
