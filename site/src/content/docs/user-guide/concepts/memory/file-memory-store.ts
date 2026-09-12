import { Agent, BedrockModel, MemoryManager } from '@strands-agents/sdk'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { S3Storage } from '@strands-agents/sdk/storage'
import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'

// =====================
// Basic usage
// =====================

function basic() {
  // --8<-- [start:basic]
  const store = new FileMemoryStore({ name: 'agent-memory' })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: new MemoryManager({
      stores: [store],
    }),
  })
  // --8<-- [end:basic]

  void agent
}
void basic

// =====================
// Custom storage backend
// =====================

function customStorage() {
  // --8<-- [start:custom_storage]
  const store = new FileMemoryStore({
    name: 'agent-memory',
    storage: new S3Storage({ bucket: 'my-memory-bucket' }),
  })
  // --8<-- [end:custom_storage]

  void store
}
void customStorage

// =====================
// Search and add
// =====================

async function searchAndAdd() {
  // --8<-- [start:search_and_add]
  const store = new FileMemoryStore({ name: 'agent-memory' })

  await store.add('# Travel preferences\n- Prefers aisle seats')

  const results = await store.search('seat preference')
  for (const entry of results) {
    console.log(entry.content, entry.metadata?.score)
  }
  // --8<-- [end:search_and_add]
}
void searchAndAdd

// =====================
// Custom search strategy (BM25 via QMD)
// =====================

function customSearch() {
  // --8<-- [start:custom_search]
  const store = new FileMemoryStore({
    name: 'agent-memory',
    search: new QmdSearchStrategy(),
  })
  // --8<-- [end:custom_search]

  void store
}
void customSearch

// =====================
// Extraction with defaults
// =====================

function extraction() {
  // --8<-- [start:extraction]
  const store = new FileMemoryStore({
    name: 'agent-memory',
    extraction: true,
  })
  // --8<-- [end:extraction]

  void store
}
void extraction

// =====================
// Extraction with custom model
// =====================

function extractionCustom() {
  // --8<-- [start:extraction_custom]
  const store = new FileMemoryStore({
    name: 'agent-memory',
    extraction: {
      model: new BedrockModel({
        modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      }),
      systemPrompt:
        'Extract durable user preferences as discrete facts.',
    },
  })
  // --8<-- [end:extraction_custom]

  void store
}
void extractionCustom
