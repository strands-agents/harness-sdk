import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'

async function keywordSearch() {
  // --8<-- [start:keyword_search]
  const storage = new LocalFileStorage('./my-data/')
  const results = await KeywordSearchStrategy.search(
    storage,
    'dark mode toggle',
  )
  // --8<-- [end:keyword_search]
}

async function qmdSearch() {
  // --8<-- [start:qmd_search]
  const storage = new LocalFileStorage('./memory/')
  const search = new QmdSearchStrategy()

  const results = await search.search(
    storage,
    'authentication flow',
  )

  await search.close()
  // --8<-- [end:qmd_search]
}

async function fileMemoryQmd() {
  // --8<-- [start:file_memory_qmd]
  const store = new FileMemoryStore({
    name: 'agent-memory',
    storage: new LocalFileStorage('./memory/'),
    search: new QmdSearchStrategy(),
  })
  // --8<-- [end:file_memory_qmd]
}
