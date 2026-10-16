import { describe, expect, it } from 'vitest'

import { BidiAgent } from '../agent.js'
import { BidiModel } from '../../models/model.js'
import type { BidiModelConfig } from '../../models/configs.js'
import type { BidiOutputEvent } from '../../types/events.js'
import { NotASandboxLocalEnvironment } from '../../../sandbox/not-a-sandbox-local-environment.js'

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

// The unit-node project registers the Node defaults, mirroring index.node.ts.
describe('BidiAgent.sandbox (node)', () => {
  it('defaults to the host environment', () => {
    const agent = new BidiAgent({ model: new FakeBidiModel() })

    expect(agent.sandbox).toBeInstanceOf(NotASandboxLocalEnvironment)
    expect(agent.sandbox).toBe(agent.sandbox)
  })

  it('falls back to the host environment when the sandbox is opted out', () => {
    expect(new BidiAgent({ model: new FakeBidiModel(), sandbox: false }).sandbox).toBeInstanceOf(
      NotASandboxLocalEnvironment
    )
  })
})
