import { describe, it, expect } from 'vitest'
import type { Plugin } from '../plugin.js'
import { BeforeInvocationEvent, type HookableEvent } from '../../hooks/events.js'
import { ToolRegistry } from '../../registry/tool-registry.js'
import type { HookableEventConstructor, HookCallback, HookCleanup } from '../../hooks/types.js'
import type { LocalAgent } from '../../types/agent.js'
import { createRandomTool } from '../../__fixtures__/tool-helpers.js'

/**
 * Concrete implementation of Plugin for testing purposes.
 */
class TestPlugin implements Plugin {
  callbacks: Array<{ eventType: unknown; callback: unknown }> = []

  get name(): string {
    return 'test-plugin'
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, () => {
      // No-op for testing
    })
  }
}

/**
 * Plugin with custom name for testing.
 */
class CustomNamePlugin implements Plugin {
  private readonly _name: string

  constructor(name: string) {
    this._name = name
  }

  get name(): string {
    return this._name
  }

  initAgent(_agent: LocalAgent): void {}
}

/**
 * Plugin with initAgent implementation for testing.
 */
class InitializablePlugin implements Plugin {
  public initialized = false

  get name(): string {
    return 'initializable-plugin'
  }

  initAgent(_agent: LocalAgent): void {
    this.initialized = true
  }
}

describe('Plugin', () => {
  describe('name', () => {
    it('returns the plugin name', () => {
      const plugin = new TestPlugin()
      expect(plugin.name).toBe('test-plugin')
    })

    it('supports custom names via constructor', () => {
      const plugin = new CustomNamePlugin('my-custom-plugin')
      expect(plugin.name).toBe('my-custom-plugin')
    })
  })

  describe('initAgent', () => {
    it('registers callbacks via agent.addHook', () => {
      const plugin = new TestPlugin()
      const callbacks: Array<{
        eventType: HookableEventConstructor<HookableEvent>
        callback: HookCallback<HookableEvent>
      }> = []
      const mockAgent = {
        addHook: <T extends HookableEvent>(
          eventType: HookableEventConstructor<T>,
          callback: HookCallback<T>
        ): HookCleanup => {
          callbacks.push({
            eventType: eventType as HookableEventConstructor<HookableEvent>,
            callback: callback as HookCallback<HookableEvent>,
          })
          return () => {}
        },
        toolRegistry: new ToolRegistry(),
      } as unknown as LocalAgent

      plugin.initAgent(mockAgent)

      expect(callbacks).toHaveLength(1)
      expect(callbacks[0]?.eventType).toBe(BeforeInvocationEvent)
    })

    it('has a no-op default when not overridden', () => {
      const plugin: Plugin = new CustomNamePlugin('test')
      const mockAgent = {
        addHook: () => () => {},
        toolRegistry: new ToolRegistry(),
      } as unknown as LocalAgent

      // Should not throw and return undefined
      const result = plugin.initAgent(mockAgent)
      expect(result).toBeUndefined()
    })

    it('can be implemented for custom initialization', () => {
      const plugin = new InitializablePlugin()
      const mockAgent = {
        addHook: () => () => {},
        toolRegistry: new ToolRegistry(),
      } as unknown as LocalAgent

      expect(plugin.initialized).toBe(false)

      plugin.initAgent(mockAgent)

      expect(plugin.initialized).toBe(true)
    })
  })

  describe('getTools', () => {
    it('is optional — plugins without getTools are valid', () => {
      const plugin: Plugin = new TestPlugin()
      expect(plugin.getTools).toBeUndefined()
    })

    it('can be implemented to provide tools', () => {
      const mockTool = createRandomTool()
      class ToolPlugin implements Plugin {
        get name(): string {
          return 'tool-plugin'
        }
        initAgent(_agent: LocalAgent): void {}
        getTools() {
          return [mockTool]
        }
      }

      expect(new ToolPlugin().getTools()).toStrictEqual([mockTool])
    })
  })
})
