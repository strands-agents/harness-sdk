import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
import { LocalFileStorage } from '@strands-agents/sdk/storage'

async function keywordSearch() {
  // --8<-- [start:keyword_search]
  const storage = new LocalFileStorage('./my-data/')
  const results = await KeywordSearchStrategy.search(
    storage,
    'dark mode toggle',
  )
  // --8<-- [end:keyword_search]
}

async function bm25Search() {
  // --8<-- [start:bm25_search]
  const search = new QmdSearchStrategy()
  const storage = new LocalFileStorage(
    './memory/',
    undefined,
    search,
  )

  await storage.write(
    'auth.md',
    new TextEncoder().encode(
      'OAuth2 authentication flow',
    ),
  )
  const results = await storage.search(
    'authentication',
  )

  await search.close()
  // --8<-- [end:bm25_search]
}

async function storageWithStrategy() {
  // --8<-- [start:storage_with_strategy]
  const storage = new LocalFileStorage(
    './memory/',
    undefined,
    new QmdSearchStrategy(),
  )
  // --8<-- [end:storage_with_strategy]
}
