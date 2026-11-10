import { type LocalAgent, MemoryManager, type MemoryStore, type Plugin } from '@strands-agents/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HarnessAgentOptions } from '../src/agent.js'

// Capture the parent config `createHarness` hands the built-in tool builder, which is what the
// `subagent` child is rebuilt from.
const captured: HarnessAgentOptions[] = []

vi.mock('../src/builtin-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/builtin-tools.js')>()
  return {
    ...actual,
    buildBuiltinTools: (...args: Parameters<typeof actual.buildBuiltinTools>) => {
      captured.push(args[1])
      return actual.buildBuiltinTools(...args)
    },
  }
})

const { createHarness } = await import('../src/agent.js')

const store: MemoryStore = { name: 'custom', writable: true, search: async () => [], add: async () => undefined }

describe('subagent memory forwarding', () => {
  beforeEach(() => {
    captured.length = 0
  })

  it('disables the delegate’s memory when the parent uses a custom memoryManager', async () => {
    await createHarness({ memoryManager: new MemoryManager({ stores: [store] }) })
    expect(captured[0]?.memory).toBe(false)
  })

  it('forwards the parent memory stores to the delegate so it shares the same backend', async () => {
    await createHarness({ memory: { stores: [store] } })
    const memory = captured[0]?.memory
    expect(memory).not.toBe(false)
    expect((memory as { stores?: unknown }).stores).toEqual([store])
  })
})

describe('subagent plugin forwarding', () => {
  beforeEach(() => {
    captured.length = 0
  })

  it('forwards consumer plugins to the delegate so its policy/observability hooks run there too', async () => {
    class PolicyPlugin implements Plugin {
      readonly name = 'policy'
      initAgent(_agent: LocalAgent): void {}
    }
    const policy = new PolicyPlugin()
    await createHarness({ plugins: [policy] })
    expect(captured[0]?.plugins).toContain(policy)
  })
})
