import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
import { InMemoryStorage, LocalFileStorage } from '@strands-agents/sdk/storage'
import type { Storage } from '@strands-agents/sdk/storage'
import type {
  SearchStrategy,
  StorageSearchResult,
} from '@strands-agents/sdk/storage/search'

async function keywordSearch() {
  // --8<-- [start:keyword_search]
  const storage = new LocalFileStorage('./my-data/')
  const results = await KeywordSearchStrategy.search(storage, 'dark mode toggle')
  // --8<-- [end:keyword_search]
}

async function bm25Search() {
  // --8<-- [start:bm25_search]
  const search = new QmdSearchStrategy()
  const storage = new LocalFileStorage('./memory/', {
    searchStrategy: search,
  })

  await storage.write('auth.md', new TextEncoder().encode('OAuth2 authentication flow'))
  const results = await storage.search('authentication')

  await search.close()
  // --8<-- [end:bm25_search]
}

async function storageWithStrategy() {
  // --8<-- [start:storage_with_strategy]
  const storage = new LocalFileStorage('./memory/', {
    searchStrategy: new QmdSearchStrategy(),
  })
  // --8<-- [end:storage_with_strategy]
}

async function customStrategy() {
  // --8<-- [start:custom_strategy]
  // Rank entries by how often the exact query phrase appears.
  const phraseSearch: SearchStrategy = {
    async search(storage: Storage, query: string): Promise<StorageSearchResult[]> {
      const phrase = query.trim().toLowerCase()
      if (!phrase) return []
      const results: StorageSearchResult[] = []
      for (const key of await storage.list('')) {
        const data = await storage.read(key)
        if (!data) continue
        const text = new TextDecoder().decode(data)
        const count = text.toLowerCase().split(phrase).length - 1
        if (count > 0) results.push({ key, score: count, data })
      }
      return results.sort((a, b) => b.score - a.score)
    },
  }

  const storage = new InMemoryStorage({
    searchStrategy: phraseSearch,
  })
  // --8<-- [end:custom_strategy]
}
