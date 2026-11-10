import { describe, it, expect } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { NotASandboxLocalEnvironment } from '../not-a-sandbox-local-environment.js'
import { defaultSandbox } from '../default.js'

describe('default sandbox registry', () => {
  it('returns the instance registered by the setup file', () => {
    expect(defaultSandbox.get()).toBeInstanceOf(NotASandboxLocalEnvironment)
  })
})

describe('Agent.sandbox getter', () => {
  it('returns the configured sandbox when one is provided', () => {
    const sandbox = new NotASandboxLocalEnvironment()
    expect(new Agent({ model: new MockMessageModel(), sandbox }).sandbox).toBe(sandbox)
  })

  it('falls back to the registered default when unconfigured', () => {
    expect(new Agent({ model: new MockMessageModel() }).sandbox).toBeInstanceOf(NotASandboxLocalEnvironment)
  })

  it('treats sandbox: false the same as unconfigured', () => {
    expect(new Agent({ model: new MockMessageModel(), sandbox: false }).sandbox).toBeInstanceOf(
      NotASandboxLocalEnvironment
    )
  })
})
