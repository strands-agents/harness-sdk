import type { MemoryManager, MemoryStore, Model } from '@strands-agents/sdk'

/**
 * The stores a resolved manager wraps, reached through the manager's private field. Throws loudly
 * if the SDK renames the field, so an SDK bump fails here with an actionable message rather than a
 * cryptic `undefined` downstream.
 */
export function storesOf(manager: MemoryManager): MemoryStore[] {
  const stores = (manager as unknown as { _searchStores?: MemoryStore[] })._searchStores
  if (stores === undefined) {
    throw new Error('MemoryManager._searchStores shape changed; update this test for the new SDK internals.')
  }
  return stores
}

/** The first store a resolved manager wraps. */
export function storeOf(manager: MemoryManager): MemoryStore {
  const store = storesOf(manager)[0]
  if (store === undefined) {
    throw new Error('MemoryManager wraps no stores; expected at least one.')
  }
  return store
}

/** The extraction model the first store's configured extractor runs on, or undefined when none. */
export function extractionModel(manager: MemoryManager): Model | undefined {
  const bindings = (manager as unknown as { _extractionStores?: Array<{ config: { extractor?: { _model?: Model } } }> })
    ._extractionStores
  if (bindings === undefined) {
    throw new Error('MemoryManager._extractionStores shape changed; update this test for the new SDK internals.')
  }
  return bindings[0]?.config.extractor?._model
}

/** The injection trigger the resolved manager uses, reached through its private field. */
export function injectionTrigger(manager: MemoryManager): unknown {
  const config = (manager as unknown as { _injectionConfig?: { trigger?: unknown } | false })._injectionConfig
  if (config === undefined) {
    throw new Error('MemoryManager._injectionConfig shape changed; update this test for the new SDK internals.')
  }
  if (config === false) {
    throw new Error('expected an enabled injection config, got false')
  }
  return config.trigger
}
