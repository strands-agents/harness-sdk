import { describe, it, expect } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

// The unit-browser project has no setupFiles registering a default sandbox,
// mirroring a real browser where index.node.ts never loads.
describe('Agent.sandbox getter (browser)', () => {
  it('throws when unconfigured because no default sandbox is registered', () => {
    expect(() => new Agent({ model: new MockMessageModel() }).sandbox).toThrow('No Sandbox configured')
  })
})
