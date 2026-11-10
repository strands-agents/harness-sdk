import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '../tool-registry.js'
import { ToolNotFoundError, ToolValidationError } from '../../errors.js'
import type { Tool, ToolStreamGenerator } from '../../tools/tool.js'
import { ToolStreamEvent } from '../../tools/tool.js'
import { ToolResultBlock } from '../../types/messages.js'

const createMockTool = (overrides: Partial<Tool> = {}): Tool => ({
  name: 'valid-tool',
  description: 'A valid tool description.',
  toolSpec: {
    name: 'valid-tool',
    description: 'A valid tool description.',
    inputSchema: { type: 'object', properties: {} },
  },
  stream: async function* (): ToolStreamGenerator {
    yield new ToolStreamEvent({ data: 'mock data' })
    return new ToolResultBlock({ toolUseId: '', status: 'success', content: [] })
  },
  ...overrides,
})

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  describe('add', () => {
    it('registers a single tool', () => {
      const tool = createMockTool()
      registry.add(tool)
      expect(registry.list()).toStrictEqual([tool])
    })

    it('registers an array of tools', () => {
      const tool1 = createMockTool({ name: 'tool-1' })
      const tool2 = createMockTool({ name: 'tool-2' })
      registry.add([tool1, tool2])
      expect(registry.list()).toStrictEqual([tool1, tool2])
    })

    it('throws ToolValidationError for a duplicate tool name', () => {
      registry.add(createMockTool({ name: 'duplicate' }))
      expect(() => registry.add(createMockTool({ name: 'duplicate' }))).toThrow(ToolValidationError)
      expect(() => registry.add(createMockTool({ name: 'duplicate' }))).toThrow(
        "Tool with name 'duplicate' already registered"
      )
    })

    it("throws ToolValidationError when a name differs only by '-' vs '_'", () => {
      registry.add(createMockTool({ name: 'foo-bar' }))
      expect(() => registry.add(createMockTool({ name: 'foo_bar' }))).toThrow(ToolValidationError)
      expect(() => registry.add(createMockTool({ name: 'foo_bar' }))).toThrow(
        "Tool name 'foo_bar' already exists as 'foo-bar'. Cannot add a duplicate tool which differs by a '-' or '_'"
      )
    })

    it('throws ToolValidationError for an invalid tool name pattern', () => {
      expect(() => registry.add(createMockTool({ name: 'invalid name!' }))).toThrow(ToolValidationError)
      expect(() => registry.add(createMockTool({ name: 'invalid name!' }))).toThrow(
        'Tool name must contain only alphanumeric characters, hyphens, and underscores'
      )
    })

    it('throws ToolValidationError for a tool name that is too long', () => {
      expect(() => registry.add(createMockTool({ name: 'a'.repeat(65) }))).toThrow(ToolValidationError)
      expect(() => registry.add(createMockTool({ name: 'a'.repeat(65) }))).toThrow(
        'Tool name must be between 1 and 64 characters'
      )
    })

    it('throws ToolValidationError for a tool name that is too short', () => {
      expect(() => registry.add(createMockTool({ name: '' }))).toThrow(ToolValidationError)
      expect(() => registry.add(createMockTool({ name: '' }))).toThrow('Tool name must be between 1 and 64 characters')
    })

    it('throws ToolValidationError for a non-string tool name', () => {
      // @ts-expect-error - Testing invalid type for name
      expect(() => registry.add(createMockTool({ name: 123 }))).toThrow(ToolValidationError)
      // @ts-expect-error - Testing invalid type for name
      expect(() => registry.add(createMockTool({ name: 123 }))).toThrow('Tool name must be a string')
    })

    it('throws ToolValidationError for an invalid description', () => {
      // @ts-expect-error - Testing invalid type for description
      expect(() => registry.add(createMockTool({ description: 123 }))).toThrow(ToolValidationError)
      // @ts-expect-error - Testing invalid type for description
      expect(() => registry.add(createMockTool({ description: 123 }))).toThrow(
        'Tool description must be a non-empty string'
      )
    })

    it('throws ToolValidationError for an empty string description', () => {
      expect(() => registry.add(createMockTool({ description: '' }))).toThrow(ToolValidationError)
      expect(() => registry.add(createMockTool({ description: '' }))).toThrow(
        'Tool description must be a non-empty string'
      )
    })

    it('allows a tool with a null or undefined description', () => {
      const tool1 = createMockTool({ name: 'tool-1' })
      // @ts-expect-error - Testing explicit undefined description
      tool1.description = undefined

      const tool2 = createMockTool({ name: 'tool-2' })
      // @ts-expect-error - Testing explicit null description
      tool2.description = null

      registry.add([tool1, tool2])
      expect(registry.list()).toHaveLength(2)
    })

    it('registers a tool with a name at the maximum length', () => {
      const tool = createMockTool({ name: 'a'.repeat(64) })
      expect(() => registry.add(tool)).not.toThrow()
    })
  })

  describe('addOrReplace', () => {
    it('registers tools', () => {
      const tool = createMockTool({ name: 'tool-1' })
      registry.addOrReplace([tool])
      expect(registry.get('tool-1')).toBe(tool)
    })

    it('replaces an existing tool with the same name', () => {
      const original = createMockTool({ name: 'tool-1', description: 'original' })
      const replacement = createMockTool({ name: 'tool-1', description: 'replacement' })
      registry.add(original)
      registry.addOrReplace([replacement])
      expect(registry.get('tool-1')).toBe(replacement)
    })

    it('validates tool properties', () => {
      expect(() => registry.addOrReplace([createMockTool({ name: 'invalid name!' })])).toThrow(ToolValidationError)
    })

    it("throws ToolValidationError when a new tool name differs only by '-' vs '_'", () => {
      registry.add(createMockTool({ name: 'foo-bar' }))
      expect(() => registry.addOrReplace([createMockTool({ name: 'foo_bar' })])).toThrow(ToolValidationError)
    })
  })

  describe('get', () => {
    it('retrieves a tool by name', () => {
      const tool = createMockTool({ name: 'find-me' })
      registry.add(tool)
      expect(registry.get('find-me')).toBe(tool)
    })

    it('returns undefined for a non-existent tool', () => {
      expect(registry.get('non-existent')).toBeUndefined()
    })
  })

  describe('resolve', () => {
    it('returns the tool for an exact name match', () => {
      const tool = createMockTool({ name: 'my-tool' })
      registry.add(tool)
      expect(registry.resolve('my-tool')).toBe(tool)
    })

    it('resolves underscore-to-hyphen substitution', () => {
      const tool = createMockTool({ name: 'my-tool' })
      registry.add(tool)
      expect(registry.resolve('my_tool')).toBe(tool)
    })

    it('resolves case-insensitively', () => {
      const tool = createMockTool({ name: 'MyTool' })
      registry.add(tool)
      expect(registry.resolve('mytool')).toBe(tool)
    })

    it('prefers exact match over case-insensitive match', () => {
      const exact = createMockTool({ name: 'mytool' })
      const cased = createMockTool({ name: 'MYTOOL' })
      // exact must come first because the validator forbids names that differ
      // only by '-'/'_'; case-only diffs are allowed.
      registry.add([exact, cased])
      expect(registry.resolve('mytool')).toBe(exact)
    })

    it('prefers exact match over underscore-to-hyphen match', () => {
      const exact = createMockTool({ name: 'my_tool' })
      registry.add(exact)
      // No hyphen variant present — exact is the only candidate.
      expect(registry.resolve('my_tool')).toBe(exact)
    })

    it('throws ToolNotFoundError when no tool matches', () => {
      registry.add(createMockTool({ name: 'existing-tool' }))
      expect(() => registry.resolve('nonexistent')).toThrow(ToolNotFoundError)
    })

    it('attaches the requested name to the thrown ToolNotFoundError', () => {
      try {
        registry.resolve('missing')
        throw new Error('expected resolve() to throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ToolNotFoundError)
        expect((e as ToolNotFoundError).toolName).toBe('missing')
        expect((e as ToolNotFoundError).message).toBe("Tool 'missing' not found")
      }
    })

    it('throws ToolNotFoundError when registry is empty', () => {
      expect(() => registry.resolve('anything')).toThrow(ToolNotFoundError)
    })
  })

  describe('remove', () => {
    it('removes a tool by name', () => {
      registry.add(createMockTool({ name: 'remove-me' }))
      registry.remove('remove-me')
      expect(registry.get('remove-me')).toBeUndefined()
    })

    it('does not throw when removing a non-existent tool', () => {
      expect(() => registry.remove('non-existent')).not.toThrow()
    })
  })

  describe('list', () => {
    it('returns an empty array when no tools are registered', () => {
      expect(registry.list()).toStrictEqual([])
    })

    it('returns all registered tools', () => {
      const tool1 = createMockTool({ name: 'tool-1' })
      const tool2 = createMockTool({ name: 'tool-2' })
      registry.add([tool1, tool2])
      expect(registry.list()).toStrictEqual([tool1, tool2])
    })
  })

  describe('clear', () => {
    it('should remove all registered tools', () => {
      registry.add([createMockTool({ name: 'tool-1' }), createMockTool({ name: 'tool-2' })])
      registry.clear()
      expect(registry.list()).toStrictEqual([])
    })

    it('should be a no-op on an empty registry', () => {
      expect(() => registry.clear()).not.toThrow()
      expect(registry.list()).toStrictEqual([])
    })
  })

  describe('constructor', () => {
    it('accepts initial tools', () => {
      const tool = createMockTool()
      const reg = new ToolRegistry([tool])
      expect(reg.list()).toStrictEqual([tool])
    })
  })
})
