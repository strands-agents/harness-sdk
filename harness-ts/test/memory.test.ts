import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryManager, ModelRouter, type MemoryEntry, type MemoryStore } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'

import { createHarness } from '../src/agent.js'
import { resolveMemory } from '../src/memory.js'
import { extractionModel, injectionTrigger, storeOf, storesOf } from './memory-internals.js'

const DEFAULT = 'bedrock/global.anthropic.claude-opus-4-8'

function managerOf(agent: Awaited<ReturnType<typeof createHarness>>): MemoryManager | undefined {
  return agent.memoryManager
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = join(tmpdir(), `strands-memory-${tempDirs.length}-${process.pid}`)
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveMemory', () => {
  it('builds a MemoryManager over a writable FileMemoryStore named "memory"', async () => {
    const manager = await resolveMemory({ model: DEFAULT, dir: makeTempDir() })
    expect(manager).toBeInstanceOf(MemoryManager)
    const store = storeOf(manager)
    expect(store).toBeInstanceOf(FileMemoryStore)
    expect(store.name).toBe('memory')
    expect(store.writable).toBe(true)
  })

  it('exposes search_memory but no add_memory tool (extraction-only)', async () => {
    const manager = await resolveMemory({ model: DEFAULT, dir: makeTempDir() })
    const names = manager.getTools().map((t) => t.name)
    expect(names).toContain('search_memory')
    expect(names).not.toContain('add_memory')
  })

  it('distills facts on the small provider model, not the main model', async () => {
    const manager = await resolveMemory({ model: DEFAULT, dir: makeTempDir() })
    expect(extractionModel(manager)?.getConfig().modelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0')
  })

  it('extracts on a ModelRouter default model', async () => {
    const defaultModel = new BedrockModel({ modelId: 'fast' })
    const router = new ModelRouter([defaultModel, new BedrockModel({ modelId: 'deep' })])
    const manager = await resolveMemory({ model: router, dir: makeTempDir() })
    expect(extractionModel(manager)).toBe(defaultModel)
  })

  it('writes memory files directly under the memory dir, not a nested memory/ path', async () => {
    const dir = makeTempDir()
    const manager = await resolveMemory({ model: DEFAULT, dir: dir })
    const store = storeOf(manager)
    await store.add?.('# Stack\nThe user works in TypeScript.')
    expect(existsSync(join(dir, 'stack.md'))).toBe(true)
    expect(readFileSync(join(dir, 'stack.md'), 'utf8')).toContain('TypeScript')
  })

  it('extracts on an explicit web_fetch.model override when one is set', async () => {
    const manager = await resolveMemory({
      model: 'bedrock/global.anthropic.claude-opus-4-8',
      dir: makeTempDir(),
      webFetch: { model: 'bedrock/us.amazon.nova-lite-v1:0' },
    })
    expect(extractionModel(manager)?.getConfig().modelId).toBe('us.amazon.nova-lite-v1:0')
  })

  it('injects memory on every turn, not only on a fresh user ask', async () => {
    const manager = await resolveMemory({ model: DEFAULT, dir: makeTempDir() })
    expect(injectionTrigger(manager)).toBe('everyTurn')
  })

  it('builds a recall-only store (searchable, no writes, no extraction) when writable is false', async () => {
    const manager = await resolveMemory({ model: DEFAULT, dir: makeTempDir(), writable: false })
    const store = storeOf(manager)
    expect(store).toBeInstanceOf(FileMemoryStore)
    expect(store.writable).toBe(false)
    expect(manager.getTools().map((tool) => tool.name)).toContain('search_memory')
    expect(extractionModel(manager)).toBeUndefined()
    expect(injectionTrigger(manager)).toBe('everyTurn')
  })

  it('manages consumer-supplied stores instead of the default file store', async () => {
    const first: MemoryStore = { name: 'first', writable: true, search: async () => [], add: async () => undefined }
    const second: MemoryStore = { name: 'second', writable: false, search: async () => [] }
    const manager = await resolveMemory({ stores: [first, second] })
    expect(storesOf(manager)).toEqual([first, second])
  })

  it('falls back to the default file store when stores is an empty array', async () => {
    const manager = await resolveMemory({ model: DEFAULT, dir: makeTempDir(), stores: [] })
    const store = storeOf(manager)
    expect(store).toBeInstanceOf(FileMemoryStore)
    expect(store.name).toBe('memory')
  })

  it('wraps consumer stores read-only (searchable, no write path) when writable is false', async () => {
    const entries: MemoryEntry[] = [{ content: 'recalled' }]
    const initialize = vi.fn(async () => undefined)
    const backing: MemoryStore = {
      name: 'backing',
      description: 'org knowledge',
      maxSearchResults: 7,
      writable: true,
      search: async () => entries,
      add: async () => undefined,
      addMessages: async () => undefined,
      initialize,
    }
    const manager = await resolveMemory({ stores: backing, writable: false })
    const view = storeOf(manager)
    expect(view.name).toBe('backing')
    expect(view.description).toBe('org knowledge')
    expect(view.maxSearchResults).toBe(7)
    expect(view.writable).toBe(false)
    expect(view.add).toBeUndefined()
    expect(view.addMessages).toBeUndefined()
    expect(await view.search('anything')).toEqual(entries)
    await view.initialize?.()
    expect(initialize).toHaveBeenCalledOnce()
    expect(extractionModel(manager)).toBeUndefined()
    expect(manager.getTools().map((tool) => tool.name)).toContain('search_memory')
  })
})

describe('createHarness memory', () => {
  it('attaches a memory manager by default', async () => {
    const agent = await createHarness({ memory: { dir: makeTempDir() } })
    expect(managerOf(agent)).toBeInstanceOf(MemoryManager)
  })

  it('attaches no memory manager when memory is disabled', async () => {
    const agent = await createHarness({ memory: false })
    expect(managerOf(agent)).toBeUndefined()
  })

  it('treats null as disabled', async () => {
    const agent = await createHarness({ memory: null })
    expect(managerOf(agent)).toBeUndefined()
  })

  it('passes a MemoryManager instance given as memory straight through', async () => {
    const store: MemoryStore = { name: 'custom', writable: false, search: async () => [] }
    const supplied = new MemoryManager({ stores: [store] })
    const agent = await createHarness({ memory: supplied })
    expect(managerOf(agent)).toBe(supplied)
  })

  it('lets a memoryManager escape hatch win over a memory config', async () => {
    const store: MemoryStore = { name: 'custom', writable: false, search: async () => [] }
    const explicit = new MemoryManager({ stores: [store] })
    const agent = await createHarness({ memory: { dir: makeTempDir() }, memoryManager: explicit })
    expect(managerOf(agent)).toBe(explicit)
  })

  it('lets an explicit memoryManager win over the default', async () => {
    const store: MemoryStore = { name: 'custom', writable: false, search: async () => [] }
    const explicit = new MemoryManager({ stores: [store] })
    const agent = await createHarness({ memoryManager: explicit })
    expect(managerOf(agent)).toBe(explicit)
  })

  it('honors a custom memory dir', async () => {
    const dir = makeTempDir()
    const agent = await createHarness({ memory: { dir } })
    const store = storeOf(managerOf(agent)!)
    await store.add?.('# Note\nremember this')
    expect(existsSync(join(dir, 'note.md'))).toBe(true)
  })

  it('manages consumer memory stores under the harness policy instead of the default file store', async () => {
    const custom: MemoryStore = { name: 'custom', writable: true, search: async () => [], add: async () => undefined }
    const agent = await createHarness({ memory: { stores: [custom] } })
    expect(storeOf(managerOf(agent)!)).toBe(custom)
    expect(
      managerOf(agent)!
        .getTools()
        .map((tool) => tool.name)
    ).toContain('search_memory')
  })
})
