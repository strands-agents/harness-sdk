import { describe, expect, it } from 'vitest'

import { BidiAgent } from '../agent.js'
import { BidiModel } from '../../models/model.js'
import type { BidiModelConfig } from '../../models/configs.js'
import type { BidiOutputEvent } from '../../types/events.js'

class FakeBidiModel extends BidiModel {
  updateConfig(_modelConfig: BidiModelConfig): void {}
  getConfig(): BidiModelConfig {
    return { modelId: 'mock-model' }
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(): Promise<void> {}
  async *receive(): AsyncGenerator<BidiOutputEvent> {}
}

// The unit-browser project registers no defaults, mirroring a real browser where index.node.ts never loads.
describe('BidiAgent.sandbox (browser)', () => {
  it('constructs without a sandbox', () => {
    expect(() => new BidiAgent({ model: new FakeBidiModel() })).not.toThrow()
  })

  it('throws on access when unconfigured because no default sandbox is registered', () => {
    expect(() => new BidiAgent({ model: new FakeBidiModel() }).sandbox).toThrow('No Sandbox configured')
  })
})
