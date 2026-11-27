import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PluginRegistry } from '../registry.js'
import type { Plugin } from '../plugin.js'
import { BeforeInvocationEvent, type HookableEvent } from '../../hooks/events.js'
import type { Tool } from '../../tools/tool.js'
import type { HookableEventConstructor, HookCallback } from '../../hooks/types.js'
import type { LocalAgent } from '../../types/agent.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { createRandomTool } from '../../__fixtures__/tool-helpers.js'

/**
 * Test plugin implementation.
 */
class TestPlugin implements Plugin {
  public hookRegistered = false
  private readonly _name: string

  constructor(name: string = 'test-plugin') {
    this._name = name
  }

  get name(): string {
    return this._name
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, () => {
      this.hookRegistered = true
    })
  }
}

/**
 * Plugin with initAgent for testing initialization.
 */
class InitializableTestPlugin implements Plugin {
  public initialized = false

  constructor(private readonly _name: string = 'initializable-plugin') {}

  get name(): string {
    return this._name
  }

  initAgent(_agent: LocalAgent): void {
    this.initialized = true
  }
}

/**
 * Plugin that provides tools.
 */
class ToolProviderPlugin implements Plugin {
  constructor(
    private readonly _name: string,
    private readonly _tools: Tool[]
  ) {}

  get name(): string {
    return this._name
  }

  initAgent(_agent: LocalAgent): void {}

  getTools(): Tool[] {
    return this._tools
  }
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry
  let mockAgent: LocalAgent
  let registeredHooks: Array<{
    eventType: HookableEventConstructor<HookableEvent>
    callback: HookCallback<HookableEvent>
  }>

  beforeEach(() => {
    registeredHooks = []
    mockAgent = createMockAgent({
      extra: {
        addHook: <T extends HookableEvent>(eventType: HookableEventConstructor<T>, callback: HookCallback<T>) => {
          registeredHooks.push({
            eventType: eventType as HookableEventConstructor<HookableEvent>,
            callback: callback as HookCallback<HookableEvent>,
          })
          return () => {}
        },
      },
    }) as unknown as LocalAgent
  })

  describe('initialize', () => {
    it('initializes a plugin and calls initAgent', async () => {
      const plugin = new InitializableTestPlugin()
      registry = new PluginRegistry([plugin])

      await registry.initialize(mockAgent)

      expect(plugin.initialized).toBe(true)
    })

    it('registers hooks via agent.addHook', async () => {
      const plugin = new TestPlugin()
      registry = new PluginRegistry([plugin])

      await registry.initialize(mockAgent)

      expect(registeredHooks).toHaveLength(1)
      expect(registeredHooks[0]?.eventType).toBe(BeforeInvocationEvent)
    })

    it('throws error when plugins have duplicate names', async () => {
      const plugin1 = new TestPlugin('duplicate-name')
      const plugin2 = new TestPlugin('duplicate-name')
      registry = new PluginRegistry([plugin1, plugin2])

      await expect(registry.initialize(mockAgent)).rejects.toThrow(
        'plugin_name=<duplicate-name> | plugin already registered'
      )
    })

    it('initializes multiple plugins with different names', async () => {
      const plugin1 = new TestPlugin('plugin-1')
      const plugin2 = new TestPlugin('plugin-2')
      registry = new PluginRegistry([plugin1, plugin2])

      await registry.initialize(mockAgent)

      expect(registeredHooks).toHaveLength(2)
    })

    it('auto-registers tools from plugin.getTools()', async () => {
      const mockTool = createRandomTool('mock-tool')
      const plugin = new ToolProviderPlugin('tool-provider', [mockTool])
      registry = new PluginRegistry([plugin])

      await registry.initialize(mockAgent)

      expect(mockAgent.toolRegistry.get(mockTool.name)).toBe(mockTool)
    })

    it('calls getTools after initAgent so tools can depend on initialization state', async () => {
      const mockTool = createRandomTool('deferred-tool')

      class DeferredToolPlugin implements Plugin {
        private _initialized = false

        get name(): string {
          return 'deferred-tool-plugin'
        }

        initAgent(_agent: LocalAgent): void {
          this._initialized = true
        }

        getTools(): Tool[] {
          return this._initialized ? [mockTool] : []
        }
      }

      const plugin = new DeferredToolPlugin()
      registry = new PluginRegistry([plugin])

      await registry.initialize(mockAgent)

      expect(mockAgent.toolRegistry.get(mockTool.name)).toBe(mockTool)
    })

    it('handles async initAgent', async () => {
      class AsyncPlugin implements Plugin {
        public initialized = false

        get name(): string {
          return 'async-plugin'
        }

        async initAgent(_agent: LocalAgent): Promise<void> {
          await vi.waitFor(() => Promise.resolve())
          this.initialized = true
        }
      }

      const plugin = new AsyncPlugin()
      registry = new PluginRegistry([plugin])

      await registry.initialize(mockAgent)

      expect(plugin.initialized).toBe(true)
    })

    it('preserves initAgent failures across initialization attempts', async () => {
      const initializationError = new Error('plugin initialization failed')
      const initAgent = vi.fn(() => {
        throw initializationError
      })
      registry = new PluginRegistry([{ name: 'failing-plugin', initAgent }])

      // Keeps plugin initialization fail-closed across retries.
      await expect(registry.initialize(mockAgent)).rejects.toBe(initializationError)
      await expect(registry.initialize(mockAgent)).rejects.toBe(initializationError)

      expect(initAgent).toHaveBeenCalledTimes(1)
    })

    it('is idempotent — calling initialize twice only runs plugins once', async () => {
      const plugin = new InitializableTestPlugin()
      registry = new PluginRegistry([plugin])

      await registry.initialize(mockAgent)
      plugin.initialized = false // reset to detect a second call
      await registry.initialize(mockAgent)

      expect(plugin.initialized).toBe(false)
    })
  })

  describe('hook invocation', () => {
    it('hooks are invoked when callbacks are called', async () => {
      const plugin = new TestPlugin()
      registry = new PluginRegistry([plugin])
      await registry.initialize(mockAgent)

      const callback = registeredHooks[0]?.callback
      const mockAgentData = {} as LocalAgent
      callback?.(new BeforeInvocationEvent({ agent: mockAgentData, invocationState: {} }))

      expect(plugin.hookRegistered).toBe(true)
    })
  })
})
