import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { MemoryManager } from '../memory-manager.js'
import { tool } from '../../tools/tool-factory.js'
import type { MemoryStore, MemoryEntry } from '../types.js'
import type { InvokableTool, Tool } from '../../tools/tool.js'
import { logger } from '../../logging/logger.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/messages.js'
import type { MessageData } from '../../types/messages.js'
import { InvokeModelStage } from '../../middleware/index.js'
import type { InvokeModelContext } from '../../middleware/index.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

function createMockStore(
  name: string,
  options?: {
    entries?: MemoryEntry[]
    writable?: boolean
    description?: string
    maxSearchResults?: number
    tools?: Tool[]
  }
): MemoryStore {
  const store: MemoryStore = {
    name,
    writable: !!options?.writable,
    ...(options?.description && { description: options.description }),
    ...(options?.maxSearchResults != null && { maxSearchResults: options.maxSearchResults }),
    search: vi.fn().mockResolvedValue(options?.entries ?? []),
  }
  if (options?.writable) {
    store.add = vi.fn().mockResolvedValue(undefined)
  }
  if (options?.tools) {
    store.getTools = vi.fn().mockReturnValue(options.tools)
  }
  return store
}

function createNamedTool(name: string): Tool {
  return tool({
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}),
    callback: () => 'ok',
  })
}

describe('MemoryManager', () => {
  describe('constructor', () => {
    it('throws when stores array is empty', () => {
      expect(() => new MemoryManager({ stores: [] })).toThrow('at least one store is required')
    })

    it('creates instance with valid config', () => {
      const mm = new MemoryManager({ stores: [createMockStore('test')] })
      expect(mm.name).toBe('strands:memory-manager')
    })

    it('throws when two stores share a name', () => {
      expect(() => new MemoryManager({ stores: [createMockStore('dup'), createMockStore('dup')] })).toThrow(
        "duplicate store name 'dup'"
      )
    })

    it('throws when a store is writable but has no add method', () => {
      const broken: MemoryStore = { name: 'broken', writable: true, search: vi.fn().mockResolvedValue([]) }
      expect(() => new MemoryManager({ stores: [broken] })).toThrow(
        "store 'broken' is writable but has no add or addMessages method"
      )
    })

    it('throws when addToolConfig is enabled but no stores are writable', () => {
      expect(
        () =>
          new MemoryManager({
            stores: [createMockStore('a')],
            addToolConfig: true,
          })
      ).toThrow('addToolConfig is enabled but no writable stores implement add')
    })

    it('allows addToolConfig true with a single writable store', () => {
      const mm = new MemoryManager({
        stores: [createMockStore('a', { writable: true })],
        addToolConfig: true,
      })
      expect(mm.getTools().map((t) => t.name)).toContain('add_memory')
    })

    it('allows addToolConfig true with multiple writable stores', () => {
      const mm = new MemoryManager({
        stores: [createMockStore('a', { writable: true }), createMockStore('b', { writable: true })],
        addToolConfig: true,
      })
      expect(mm.getTools().map((t) => t.name)).toContain('add_memory')
    })

    it('throws when addToolConfig.stores names a non-existent store', () => {
      expect(
        () =>
          new MemoryManager({
            stores: [createMockStore('a', { writable: true })],
            addToolConfig: { stores: ['nonexistent'] },
          })
      ).toThrow("addToolConfig store 'nonexistent' not found")
    })

    it('throws when addToolConfig.stores names a non-writable store', () => {
      expect(
        () =>
          new MemoryManager({
            stores: [createMockStore('a', { writable: true }), createMockStore('readonly')],
            addToolConfig: { stores: ['readonly'] },
          })
      ).toThrow("addToolConfig store 'readonly' is not writable")
    })

    it('accepts MemoryStore instances (not just names) in addToolConfig.stores', async () => {
      const personal = createMockStore('personal', { writable: true })
      const team = createMockStore('team', { writable: true })
      // Pass the store instance instead of its name; resolves by name to scope the tool to it.
      const mm = new MemoryManager({ stores: [personal, team], addToolConfig: { stores: [personal] } })

      const addTool = mm.getTools().find((t) => t.name === 'add_memory') as InvokableTool<
        { entries: string[]; stores?: string[] },
        unknown
      >
      await addTool.invoke({ entries: ['fact'] })
      expect(personal.add).toHaveBeenCalledWith('fact', undefined)
      expect(team.add).not.toHaveBeenCalled()
    })

    it('throws when an addToolConfig.stores instance is not a configured store', () => {
      const configured = createMockStore('configured', { writable: true })
      const stray = createMockStore('stray', { writable: true })
      expect(
        () =>
          new MemoryManager({
            stores: [configured],
            addToolConfig: { stores: [stray] },
          })
      ).toThrow("addToolConfig store 'stray' not found")
    })
  })

  describe('getTools', () => {
    it('registers search tool by default', () => {
      const mm = new MemoryManager({ stores: [createMockStore('test')] })
      const tools = mm.getTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('search_memory')
    })

    it('registers add tool when addToolConfig is enabled', () => {
      const mm = new MemoryManager({
        stores: [createMockStore('test', { writable: true })],
        addToolConfig: true,
      })
      const tools = mm.getTools()
      expect(tools.map((t) => t.name)).toStrictEqual(['search_memory', 'add_memory'])
    })

    it('does not register add tool by default', () => {
      const mm = new MemoryManager({ stores: [createMockStore('test', { writable: true })] })
      const tools = mm.getTools()
      expect(tools.map((t) => t.name)).toStrictEqual(['search_memory'])
    })

    it('returns empty array when searchToolConfig is false and addToolConfig is false', () => {
      const mm = new MemoryManager({
        stores: [createMockStore('test', { writable: true })],
        searchToolConfig: false,
        addToolConfig: false,
      })
      expect(mm.getTools()).toStrictEqual([])
    })

    it('uses custom tool names from MemoryToolConfig', () => {
      const mm = new MemoryManager({
        stores: [createMockStore('test', { writable: true })],
        searchToolConfig: { name: 'recall' },
        addToolConfig: { name: 'remember' },
      })
      const tools = mm.getTools()
      expect(tools.map((t) => t.name)).toStrictEqual(['recall', 'remember'])
    })

    it('includes store descriptions in search tool description', () => {
      const store = createMockStore('personal', { description: 'User preferences' })
      const mm = new MemoryManager({ stores: [store] })
      const tools = mm.getTools()
      expect(tools[0]!.description).toContain('personal: User preferences')
      expect(tools[0]!.description).toContain('target one or more memory stores by name')
    })

    it('includes store descriptions in add tool description', () => {
      const store = createMockStore('notes', { writable: true, description: 'Personal notes' })
      const mm = new MemoryManager({ stores: [store], addToolConfig: true })
      const tools = mm.getTools()
      const addTool = tools.find((t) => t.name === 'add_memory')!
      expect(addTool.description).toContain('notes: Personal notes')
      expect(addTool.description).toContain('target a specific store by name')
    })

    it('aggregates tools provided by stores via getTools', () => {
      const store = createMockStore('kb', { tools: [createNamedTool('kb_query')] })
      const mm = new MemoryManager({ stores: [store] })

      expect(mm.getTools().map((t) => t.name)).toStrictEqual(['search_memory', 'kb_query'])
    })

    it('aggregates store tools across multiple stores alongside the manager tools', () => {
      const a = createMockStore('a', { writable: true, tools: [createNamedTool('a_tool')] })
      const b = createMockStore('b', { tools: [createNamedTool('b_tool')] })
      const mm = new MemoryManager({ stores: [a, b], addToolConfig: true })

      expect(mm.getTools().map((t) => t.name)).toStrictEqual(['search_memory', 'add_memory', 'a_tool', 'b_tool'])
    })

    it('includes store tools even when the manager registers no tools of its own', () => {
      const store = createMockStore('kb', { tools: [createNamedTool('kb_query')] })
      const mm = new MemoryManager({ stores: [store], searchToolConfig: false })

      expect(mm.getTools().map((t) => t.name)).toStrictEqual(['kb_query'])
    })
  })

  describe('search', () => {
    it('queries all stores and concatenates results', async () => {
      const store1 = createMockStore('a', { entries: [{ content: 'fact one' }] })
      const store2 = createMockStore('b', { entries: [{ content: 'fact two' }] })
      const mm = new MemoryManager({ stores: [store1, store2] })

      const results = await mm.search('query')
      expect(results).toStrictEqual([
        { content: 'fact one', storeName: 'a' },
        { content: 'fact two', storeName: 'b' },
      ])
    })

    it("resolves a store's per-instance maxSearchResults when the caller omits it", async () => {
      const store = createMockStore('a', { maxSearchResults: 5 })
      const mm = new MemoryManager({ stores: [store] })

      await mm.search('query')
      expect(store.search).toHaveBeenCalledWith('query', { maxSearchResults: 5 })
    })

    it('forwards an explicit maxSearchResults override to each store', async () => {
      const store = createMockStore('a', { maxSearchResults: 5 })
      const mm = new MemoryManager({ stores: [store] })

      await mm.search('query', { maxSearchResults: 2 })
      expect(store.search).toHaveBeenCalledWith('query', { maxSearchResults: 2 })
    })

    it('falls back to the SDK default when neither caller nor store specifies a limit', async () => {
      const store = createMockStore('a')
      const mm = new MemoryManager({ stores: [store] })

      await mm.search('query')
      expect(store.search).toHaveBeenCalledWith('query', { maxSearchResults: 3 })
    })

    it('filters to named stores when options.stores is provided', async () => {
      const store1 = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const store2 = createMockStore('team', { entries: [{ content: 'team fact' }] })
      const mm = new MemoryManager({ stores: [store1, store2] })

      const results = await mm.search('query', { stores: ['personal'] })
      expect(results).toStrictEqual([{ content: 'personal fact', storeName: 'personal' }])
      expect(store2.search).not.toHaveBeenCalled()
    })

    it('gracefully handles store failures', async () => {
      const store1: MemoryStore = {
        name: 'failing',
        writable: false,
        search: vi.fn().mockRejectedValue(new Error('network error')),
      }
      const store2 = createMockStore('ok', { entries: [{ content: 'fact' }] })
      const mm = new MemoryManager({ stores: [store1, store2] })

      const results = await mm.search('query')
      expect(results).toStrictEqual([{ content: 'fact', storeName: 'ok' }])
    })

    it('searches all stores when stores option is omitted', async () => {
      const store1 = createMockStore('a', { entries: [{ content: 'fact one' }] })
      const store2 = createMockStore('b', { entries: [{ content: 'fact two' }] })
      const mm = new MemoryManager({ stores: [store1, store2] })

      const results = await mm.search('query')
      expect(results).toStrictEqual([
        { content: 'fact one', storeName: 'a' },
        { content: 'fact two', storeName: 'b' },
      ])
    })

    it('searches no stores when stores option is an empty array', async () => {
      const store1 = createMockStore('a', { entries: [{ content: 'fact one' }] })
      const store2 = createMockStore('b', { entries: [{ content: 'fact two' }] })
      const mm = new MemoryManager({ stores: [store1, store2] })

      const results = await mm.search('query', { stores: [] })
      expect(results).toStrictEqual([])
      expect(store1.search).not.toHaveBeenCalled()
      expect(store2.search).not.toHaveBeenCalled()
    })

    it('throws a not-found error when a named store does not exist', async () => {
      const store = createMockStore('personal', { entries: [{ content: 'fact' }] })
      const mm = new MemoryManager({ stores: [store] })

      await expect(mm.search('query', { stores: ['nonexistent'] })).rejects.toThrow("store 'nonexistent' not found")
      expect(store.search).not.toHaveBeenCalled()
    })
  })

  describe('add', () => {
    it('writes to all writable stores', async () => {
      const store1 = createMockStore('a', { writable: true })
      const store2 = createMockStore('b', { writable: true })
      const mm = new MemoryManager({ stores: [store1, store2] })

      await mm.add('user likes coffee')
      expect(store1.add).toHaveBeenCalledWith('user likes coffee', undefined)
      expect(store2.add).toHaveBeenCalledWith('user likes coffee', undefined)
    })

    it('passes metadata to stores', async () => {
      const store = createMockStore('a', { writable: true })
      const mm = new MemoryManager({ stores: [store] })

      await mm.add('fact', { metadata: { source: 'user' } })
      expect(store.add).toHaveBeenCalledWith('fact', { source: 'user' })
    })

    it('filters to named stores when options.stores is provided', async () => {
      const store1 = createMockStore('personal', { writable: true })
      const store2 = createMockStore('team', { writable: true })
      const mm = new MemoryManager({ stores: [store1, store2] })

      await mm.add('my preference', { stores: ['personal'] })
      expect(store1.add).toHaveBeenCalledWith('my preference', undefined)
      expect(store2.add).not.toHaveBeenCalled()
    })

    it('dedupes duplicate store names so each store is written once', async () => {
      const store = createMockStore('personal', { writable: true })
      const mm = new MemoryManager({ stores: [store] })

      await mm.add('fact', { stores: ['personal', 'personal'] })
      expect(store.add).toHaveBeenCalledTimes(1)
    })

    it('throws when no writable stores match', async () => {
      const mm = new MemoryManager({ stores: [createMockStore('a')] })
      await expect(mm.add('fact')).rejects.toThrow('no writable store matched')
    })

    it('throws a not-found error when a named store does not exist', async () => {
      const mm = new MemoryManager({ stores: [createMockStore('a', { writable: true })] })
      await expect(mm.add('fact', { stores: ['nonexistent'] })).rejects.toThrow("store 'nonexistent' not found")
    })

    it('throws a read-only error when a named store cannot be written', async () => {
      const mm = new MemoryManager({ stores: [createMockStore('readonly')] })
      await expect(mm.add('fact', { stores: ['readonly'] })).rejects.toThrow("store 'readonly' is read-only")
    })

    it('awaits writes and throws AggregateError naming the failed store on partial failure', async () => {
      const failing: MemoryStore = {
        name: 'failing',
        writable: true,
        search: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('write error')),
      }
      const ok = createMockStore('ok', { writable: true })
      const mm = new MemoryManager({ stores: [failing, ok] })

      // The method always awaits: a partial failure (failing rejects, ok succeeds) throws.
      await expect(mm.add('fact')).rejects.toThrow('store writes failed: failing')
      expect(ok.add).toHaveBeenCalledWith('fact', undefined)
    })

    it('dispatches writes to all targeted stores', async () => {
      const store1 = createMockStore('a', { writable: true })
      const store2 = createMockStore('b', { writable: true })
      const mm = new MemoryManager({ stores: [store1, store2] })

      await mm.add('fact')
      expect(store1.add).toHaveBeenCalledWith('fact', undefined)
      expect(store2.add).toHaveBeenCalledWith('fact', undefined)
    })
  })

  describe('tool store scoping', () => {
    function searchTool(
      mm: MemoryManager
    ): InvokableTool<{ query: string; maxSearchResults?: number; stores?: string[] }, unknown> {
      return mm.getTools().find((t) => t.name === 'search_memory') as never
    }

    function addTool(mm: MemoryManager): InvokableTool<{ entries: string[]; stores?: string[] }, unknown> {
      return mm.getTools().find((t) => t.name === 'add_memory') as never
    }

    it('search tool queries all stores when model omits stores', async () => {
      const personal = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const team = createMockStore('team', { entries: [{ content: 'team fact' }] })
      const mm = new MemoryManager({ stores: [personal, team] })

      await searchTool(mm).invoke({ query: 'q' })
      expect(personal.search).toHaveBeenCalled()
      expect(team.search).toHaveBeenCalled()
    })

    it('search tool treats an empty stores array as omitted (searches all)', async () => {
      const personal = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const team = createMockStore('team', { entries: [{ content: 'team fact' }] })
      const mm = new MemoryManager({ stores: [personal, team] })

      await searchTool(mm).invoke({ query: 'q', stores: [] })
      expect(personal.search).toHaveBeenCalled()
      expect(team.search).toHaveBeenCalled()
    })

    it('search tool targets only the requested store when in scope', async () => {
      const personal = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const team = createMockStore('team', { entries: [{ content: 'team fact' }] })
      const mm = new MemoryManager({ stores: [personal, team] })

      await searchTool(mm).invoke({ query: 'q', stores: ['personal'] })
      expect(personal.search).toHaveBeenCalled()
      expect(team.search).not.toHaveBeenCalled()
    })

    it('search tool result attributes each entry to its source store', async () => {
      const personal = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const team = createMockStore('team', { entries: [{ content: 'team fact' }] })
      const mm = new MemoryManager({ stores: [personal, team] })

      const result = await searchTool(mm).invoke({ query: 'q' })
      expect(result).toStrictEqual([
        { content: 'personal fact', storeName: 'personal' },
        { content: 'team fact', storeName: 'team' },
      ])
    })

    it('search tool keeps valid names and warns on out-of-scope names', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const personal = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const team = createMockStore('team', { entries: [{ content: 'team fact' }] })
      const mm = new MemoryManager({ stores: [personal, team] })

      await searchTool(mm).invoke({ query: 'q', stores: ['personal', 'nonexistent'] })
      expect(personal.search).toHaveBeenCalled()
      expect(team.search).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
      warnSpy.mockRestore()
    })

    it('search tool throws when every requested store is out of scope', async () => {
      const personal = createMockStore('personal', { entries: [{ content: 'personal fact' }] })
      const mm = new MemoryManager({ stores: [personal] })

      await expect(searchTool(mm).invoke({ query: 'q', stores: ['nonexistent'] })).rejects.toThrow(
        'none of the requested memory stores are available'
      )
      expect(personal.search).not.toHaveBeenCalled()
    })

    it('add tool writes to all writable stores when model omits stores', async () => {
      const personal = createMockStore('personal', { writable: true })
      const team = createMockStore('team', { writable: true })
      const mm = new MemoryManager({ stores: [personal, team], addToolConfig: true })

      await addTool(mm).invoke({ entries: ['fact'] })
      expect(personal.add).toHaveBeenCalledWith('fact', undefined)
      expect(team.add).toHaveBeenCalledWith('fact', undefined)
    })

    it('add tool treats an empty stores array as omitted (writes to all writable)', async () => {
      const personal = createMockStore('personal', { writable: true })
      const team = createMockStore('team', { writable: true })
      const mm = new MemoryManager({ stores: [personal, team], addToolConfig: true })

      await addTool(mm).invoke({ entries: ['fact'], stores: [] })
      expect(personal.add).toHaveBeenCalled()
      expect(team.add).toHaveBeenCalled()
    })

    it('add tool is scoped to addToolConfig.stores (excludes other writable stores)', async () => {
      const personal = createMockStore('personal', { writable: true })
      const team = createMockStore('team', { writable: true })
      const mm = new MemoryManager({ stores: [personal, team], addToolConfig: { stores: ['personal'] } })

      // Omitting stores writes to the configured allowlist only — not every writable store.
      await addTool(mm).invoke({ entries: ['fact'] })
      expect(personal.add).toHaveBeenCalledWith('fact', undefined)
      expect(team.add).not.toHaveBeenCalled()
    })

    it('add tool rejects a writable store excluded from addToolConfig.stores (extraction-only store)', async () => {
      // `extractionOnly` is writable (e.g. to receive extraction writes) but excluded from the tool's
      // allowlist, so the agent's add_memory tool cannot write to it.
      const personal = createMockStore('personal', { writable: true })
      const extractionOnly = createMockStore('extraction-only', { writable: true })
      const mm = new MemoryManager({ stores: [personal, extractionOnly], addToolConfig: { stores: ['personal'] } })

      await expect(addTool(mm).invoke({ entries: ['fact'], stores: ['extraction-only'] })).rejects.toThrow(
        'none of the requested memory stores are available'
      )
      expect(extractionOnly.add).not.toHaveBeenCalled()
    })

    it('add tool excludes read-only stores from its scope', async () => {
      const personal = createMockStore('personal', { writable: true })
      const readonly = createMockStore('readonly')
      const mm = new MemoryManager({ stores: [personal, readonly], addToolConfig: true })

      // A read-only store is out of the add tool's scope, so naming it throws.
      await expect(addTool(mm).invoke({ entries: ['fact'], stores: ['readonly'] })).rejects.toThrow(
        'none of the requested memory stores are available'
      )
      expect(personal.add).not.toHaveBeenCalled()
    })

    it('add tool keeps valid names and warns on out-of-scope names', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const personal = createMockStore('personal', { writable: true })
      const team = createMockStore('team', { writable: true })
      const mm = new MemoryManager({ stores: [personal, team], addToolConfig: true })

      await addTool(mm).invoke({ entries: ['fact'], stores: ['personal', 'nonexistent'] })
      expect(personal.add).toHaveBeenCalledWith('fact', undefined)
      expect(team.add).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
      warnSpy.mockRestore()
    })

    it('add tool throws when every requested store is out of scope', async () => {
      const personal = createMockStore('personal', { writable: true })
      const mm = new MemoryManager({ stores: [personal], addToolConfig: true })

      await expect(addTool(mm).invoke({ entries: ['fact'], stores: ['nonexistent'] })).rejects.toThrow(
        'none of the requested memory stores are available'
      )
      expect(personal.add).not.toHaveBeenCalled()
    })

    it('add tool rejects an empty entries array', async () => {
      const personal = createMockStore('personal', { writable: true })
      const mm = new MemoryManager({ stores: [personal], addToolConfig: true })

      await expect(addTool(mm).invoke({ entries: [] })).rejects.toThrow()
      expect(personal.add).not.toHaveBeenCalled()
    })

    it('add tool returns stored count by default (awaits writes)', async () => {
      const store = createMockStore('notes', { writable: true })
      const mm = new MemoryManager({ stores: [store], addToolConfig: true })

      const result = await addTool(mm).invoke({ entries: ['a', 'b'] })
      expect(result).toStrictEqual({ stored: 2 })
    })

    it('add tool throws a flattened error with concrete reasons when entries fail (default awaits)', async () => {
      const failing: MemoryStore = {
        name: 'failing',
        writable: true,
        search: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('write error')),
      }
      const mm = new MemoryManager({ stores: [failing], addToolConfig: true })

      const error = await addTool(mm)
        .invoke({ entries: ['a', 'b'] })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AggregateError)
      const agg = error as AggregateError
      expect(agg.message).toContain('failed to add 2 of 2 entries')
      expect(agg.message).toContain('write error')
      // Leaves are the underlying store errors, not the per-entry AggregateErrors add() throws.
      expect(agg.errors).toHaveLength(2)
      expect(agg.errors.every((e) => e instanceof Error && !(e instanceof AggregateError))).toBe(true)
    })

    it('add tool with waitForWrites: false returns accepted count (fire-and-forget)', async () => {
      const store = createMockStore('notes', { writable: true })
      const mm = new MemoryManager({ stores: [store], addToolConfig: { waitForWrites: false } })

      const result = await addTool(mm).invoke({ entries: ['a', 'b'] })
      expect(result).toStrictEqual({ accepted: 2 })
    })

    it('add tool with waitForWrites: false returns accepted even when a store write fails (swallows it)', async () => {
      const failing: MemoryStore = {
        name: 'failing',
        writable: true,
        search: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockRejectedValue(new Error('write error')),
      }
      const mm = new MemoryManager({ stores: [failing], addToolConfig: { waitForWrites: false } })

      const result = await addTool(mm).invoke({ entries: ['a', 'b'] })
      expect(result).toStrictEqual({ accepted: 2 })
    })
  })

  describe('initAgent', () => {
    it('does not throw', async () => {
      const mm = new MemoryManager({ stores: [createMockStore('test')] })
      await expect(mm.initAgent(createMockAgent())).resolves.not.toThrow()
    })

    it('does not register injection middleware when injection is disabled', async () => {
      const mm = new MemoryManager({ stores: [createMockStore('test')], injection: false })
      const addMiddleware = vi.fn()
      await mm.initAgent(createMockAgent({ extra: { addMiddleware } as never }))
      expect(addMiddleware).not.toHaveBeenCalled()
    })

    it('registers an InvokeModelStage input middleware when injection is enabled', async () => {
      const mm = new MemoryManager({ stores: [createMockStore('test')], injection: true })
      const addMiddleware = vi.fn()
      await mm.initAgent(createMockAgent({ extra: { addMiddleware } as never }))

      expect(addMiddleware).toHaveBeenCalledTimes(1)
      expect(addMiddleware.mock.calls[0]![0]).toBe(InvokeModelStage.Input)
      expect(typeof addMiddleware.mock.calls[0]![1]).toBe('function')
    })

    it('wires the registered middleware to the memory provide pipeline (folds a search hit)', async () => {
      const store = createMockStore('s', { entries: [{ content: 'dark mode preferred' }] })
      const mm = new MemoryManager({ stores: [store], injection: true })
      const addMiddleware = vi.fn()
      const agent = createMockAgent({ extra: { addMiddleware } as never })
      await mm.initAgent(agent)

      const handler = addMiddleware.mock.calls[0]![1] as (ctx: InvokeModelContext) => Promise<InvokeModelContext>
      const messages = [
        new Message({ role: 'assistant', content: [new TextBlock('prior')] }),
        new Message({ role: 'user', content: [new TextBlock('what is my plan')] }),
      ]
      const result = await handler({ messages, agent } as unknown as InvokeModelContext)

      expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
        { role: 'assistant', content: [{ text: 'prior' }], trackingId: anyTrackingId },
        {
          role: 'user',
          content: [
            { text: 'what is my plan' },
            { text: '\n\n<memory>\n<entry source="s">dark mode preferred</entry>\n</memory>' },
          ],
          trackingId: anyTrackingId,
        },
      ])
      expect(store.search).toHaveBeenCalledWith('what is my plan', { maxSearchResults: 5 })
    })
  })

  // The injection delivery (folding text into the model input) is wired through the InvokeModelStage
  // input middleware (see the `initAgent` tests). The memory-owned `provide` pipeline below — query
  // derivation, search, and formatting — is exercised directly via `_provideMemoryContext`, the
  // callback the middleware invokes.
  describe('injection', () => {
    const assistant = (text: string) => new Message({ role: 'assistant', content: [new TextBlock(text)] })
    const user = (text: string) => new Message({ role: 'user', content: [new TextBlock(text)] })
    const toolUse = () =>
      new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'x', toolUseId: 't1', input: {} })] })
    const toolResult = () =>
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('done')] })],
      })

    // Calls the (private) provide pipeline with the manager's resolved injection config.
    function provide(mm: MemoryManager, messages: Message[]): Promise<string | undefined> {
      const data = messages.map((m) => m.toJSON())
      const config = (mm as unknown as { _injectionConfig: object | false })._injectionConfig
      return (
        mm as unknown as { _provideMemoryContext(m: MessageData[], c: object): Promise<string | undefined> }
      )._provideMemoryContext(data, config === false ? {} : config)
    }

    describe('config resolution', () => {
      const injectionConfig = (mm: MemoryManager) =>
        (mm as unknown as { _injectionConfig: object | false })._injectionConfig

      it('defaults to an empty config (enabled) when injection is omitted', () => {
        expect(injectionConfig(new MemoryManager({ stores: [createMockStore('s')] }))).toStrictEqual({})
      })

      it('is false when injection is explicitly false', () => {
        expect(injectionConfig(new MemoryManager({ stores: [createMockStore('s')], injection: false }))).toBe(false)
      })

      it('resolves to an empty config when injection is true', () => {
        expect(injectionConfig(new MemoryManager({ stores: [createMockStore('s')], injection: true }))).toStrictEqual(
          {}
        )
      })

      it('passes an injection config object through unchanged', () => {
        const cfg = { maxEntries: 5 }
        expect(injectionConfig(new MemoryManager({ stores: [createMockStore('s')], injection: cfg }))).toBe(cfg)
      })
    })

    describe('query', () => {
      it('uses the latest user ask on a user turn (adaptive default)', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({ stores: [store], injection: true })

        await provide(mm, [assistant('prior step'), user('what is my plan')])

        expect(store.search).toHaveBeenCalledWith('what is my plan', { maxSearchResults: 5 })
      })

      it('uses the most recent assistant text on an autonomous (tool-result) turn', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({ stores: [store], injection: true })

        await provide(mm, [user('task'), assistant('the previous step result'), toolResult()])

        expect(store.search).toHaveBeenCalledWith('the previous step result', { maxSearchResults: 5 })
      })

      it('honors a custom query', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({ stores: [store], injection: { query: () => 'custom query' } })

        await provide(mm, [assistant('prior'), user('ask')])

        expect(store.search).toHaveBeenCalledWith('custom query', { maxSearchResults: 5 })
      })

      it('skips (returns undefined) when a custom query returns undefined', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({ stores: [store], injection: { query: () => undefined } })

        await expect(provide(mm, [assistant('prior'), user('ask')])).resolves.toBeUndefined()
        expect(store.search).not.toHaveBeenCalled()
      })

      it('fails open (returns undefined) when a custom query throws', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({
          stores: [store],
          injection: {
            query: () => {
              throw new Error('boom')
            },
          },
        })

        await expect(provide(mm, [assistant('prior'), user('ask')])).resolves.toBeUndefined()
        expect(store.search).not.toHaveBeenCalled()
      })

      it('skips when the latest assistant message has no text (pure tool use)', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({ stores: [store], injection: true })

        await expect(provide(mm, [toolUse(), toolResult()])).resolves.toBeUndefined()
        expect(store.search).not.toHaveBeenCalled()
      })
    })

    describe('search', () => {
      it('returns undefined when search yields no entries', async () => {
        const store = createMockStore('s', { entries: [] })
        const mm = new MemoryManager({ stores: [store], injection: true })

        await expect(provide(mm, [assistant('prior'), user('ask')])).resolves.toBeUndefined()
        expect(store.search).toHaveBeenCalled()
      })

      it('honors maxEntries and caps the rendered entries', async () => {
        const store = createMockStore('s', {
          entries: [{ content: 'A' }, { content: 'B' }, { content: 'C' }],
        })
        const mm = new MemoryManager({
          stores: [store],
          injection: { maxEntries: 2, format: ({ entries }) => entries.map((e) => e.content).join(',') },
        })

        const text = await provide(mm, [assistant('prior'), user('ask')])

        expect(store.search).toHaveBeenCalledWith('ask', { maxSearchResults: 2 })
        expect(text).toBe('A,B')
      })
    })

    describe('format', () => {
      it('default renders a <memory> block with per-entry source attribution', async () => {
        const store = createMockStore('s', { entries: [{ content: 'dark mode preferred' }] })
        const mm = new MemoryManager({ stores: [store], injection: true })

        // search() stamps storeName onto each entry, so the default format attributes the source.
        const text = await provide(mm, [assistant('prior'), user('ask')])
        expect(text).toBe('<memory>\n<entry source="s">dark mode preferred</entry>\n</memory>')
      })

      it('omits the source attribute for an entry with no storeName', () => {
        const mm = new MemoryManager({ stores: [createMockStore('s')], injection: true })
        const text = (mm as unknown as { _defaultInjectionFormat(e: MemoryEntry[]): string })._defaultInjectionFormat([
          { content: 'no source' },
        ])
        expect(text).toBe('<memory>\n<entry>no source</entry>\n</memory>')
      })

      it('escapes XML in entry content and source so untrusted text cannot break the block', () => {
        const mm = new MemoryManager({ stores: [createMockStore('s')], injection: true })
        const text = (mm as unknown as { _defaultInjectionFormat(e: MemoryEntry[]): string })._defaultInjectionFormat([
          { content: 'a < b & c > d </entry>', storeName: 'pre"f' },
        ])
        expect(text).toBe(
          '<memory>\n<entry source="pre&quot;f">a &lt; b &amp; c &gt; d &lt;/entry&gt;</entry>\n</memory>'
        )
      })

      it('honors a custom format', async () => {
        const store = createMockStore('s', { entries: [{ content: 'A' }] })
        const mm = new MemoryManager({
          stores: [store],
          injection: { format: ({ entries }) => `[${entries.map((e) => e.content).join('|')}]` },
        })

        await expect(provide(mm, [assistant('prior'), user('ask')])).resolves.toBe('[A]')
      })

      it('fails open (returns undefined) when a custom format throws', async () => {
        const store = createMockStore('s', { entries: [{ content: 'fact' }] })
        const mm = new MemoryManager({
          stores: [store],
          injection: {
            format: () => {
              throw new Error('boom')
            },
          },
        })

        // search ran, but the format threw, so nothing is injected.
        await expect(provide(mm, [assistant('prior'), user('ask')])).resolves.toBeUndefined()
        expect(store.search).toHaveBeenCalled()
      })
    })
  })

  describe('AgentConfig integration', () => {
    it('auto-wraps MemoryManagerConfig into MemoryManager instance', () => {
      const store = createMockStore('test')
      const agent = new Agent({ memoryManager: { stores: [store] } })
      expect(agent.memoryManager).toBeInstanceOf(MemoryManager)
    })

    it('passes through MemoryManager instance unchanged', () => {
      const mm = new MemoryManager({ stores: [createMockStore('test')] })
      const agent = new Agent({ memoryManager: mm })
      expect(agent.memoryManager).toBe(mm)
    })

    it('sets memoryManager to undefined when not configured', () => {
      const agent = new Agent({})
      expect(agent.memoryManager).toBeUndefined()
    })
  })
})
