import { describe, expect, it, vi } from 'vitest'
import { MultiAgentPluginRegistry } from '../plugins.js'
import type { MultiAgent } from '../multiagent.js'

describe('MultiAgentPluginRegistry', () => {
  describe('initialize', () => {
    it('preserves initMultiAgent failures across initialization attempts', async () => {
      const initializationError = new Error('plugin initialization failed')
      const initMultiAgent = vi.fn(() => {
        throw initializationError
      })
      const registry = new MultiAgentPluginRegistry([{ name: 'failing-plugin', initMultiAgent }])
      const orchestrator = {} as MultiAgent

      // Keeps multi-agent plugin initialization fail-closed across retries.
      await expect(registry.initialize(orchestrator)).rejects.toBe(initializationError)
      await expect(registry.initialize(orchestrator)).rejects.toBe(initializationError)

      expect(initMultiAgent).toHaveBeenCalledTimes(1)
    })
  })
})
