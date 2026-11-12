import {
  Agent,
  BedrockModel,
  DocumentBlock,
  tool,
  type MemoryEntry,
} from '@strands-agents/sdk'
import {
  BedrockKnowledgeBaseStore,
  type BedrockKnowledgeBaseConfig,
} from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
import { z } from 'zod'

// =====================
// Read-only store
// =====================

function readOnly() {
  // --8<-- [start:read_only]
  const store = new BedrockKnowledgeBaseStore({
    name: 'docs',
    description: 'Company documentation and policies.',
    config: { knowledgeBaseId: 'KB123' },
  })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: { stores: [store] },
  })
  // --8<-- [end:read_only]

  void agent
}
void readOnly

// =====================
// Writable CUSTOM store
// =====================

function writableCustom() {
  // --8<-- [start:writable_custom]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    description: 'User preferences and stable facts.',
    writable: true,
    config: {
      knowledgeBaseId: 'KB123',
      dataSourceType: 'CUSTOM',
      dataSourceId: 'DS456',
    },
  })
  // --8<-- [end:writable_custom]

  void store
}
void writableCustom

// =====================
// Reuse one connection across scoped stores
// =====================

function scopedStores() {
  // --8<-- [start:scoped_stores]
  // Build the connection once, vary only name and scope per store.
  const connection: BedrockKnowledgeBaseConfig = {
    knowledgeBaseId: 'KB123',
    dataSourceType: 'CUSTOM',
    dataSourceId: 'DS456',
  }

  const alice = new BedrockKnowledgeBaseStore({
    name: 'alice',
    writable: true,
    scope: 'user-alice',
    config: connection,
  })

  const bob = new BedrockKnowledgeBaseStore({
    name: 'bob',
    writable: true,
    scope: 'user-bob',
    config: connection,
  })
  // --8<-- [end:scoped_stores]

  void alice
  void bob
}
void scopedStores

// =====================
// S3 data source
// =====================

function s3Store() {
  // --8<-- [start:s3_store]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    writable: true,
    config: {
      knowledgeBaseId: 'KB123',
      dataSourceType: 'S3',
      dataSourceId: 'DS789',
      s3: { bucket: 'my-agent-memories', prefix: 'memories/' },
    },
  })
  // --8<-- [end:s3_store]

  void store
}
void s3Store

// =====================
// Access control list
// =====================

function aclStore() {
  // --8<-- [start:acl_store]
  const store = new BedrockKnowledgeBaseStore({
    name: 'policies',
    writable: true,
    scope: 'hr',
    accessControlList: [{ access: 'ALLOW', name: 'alice@example.com', type: 'USER' }],
    config: {
      knowledgeBaseId: 'KB123',
      dataSourceType: 'CUSTOM',
      dataSourceId: 'DS456',
    },
  })
  // --8<-- [end:acl_store]

  void store
}
void aclStore

// =====================
// Search and add
// =====================

async function searchAndAdd() {
  // --8<-- [start:search]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    writable: true,
    config: { knowledgeBaseId: 'KB123', dataSourceType: 'CUSTOM', dataSourceId: 'DS456' },
  })

  const results = await store.search('what are my preferences?', { maxSearchResults: 5 })
  for (const entry of results) {
    console.log(entry.content, entry.metadata?._relevanceScore)
  }

  // add returns the new document's id (a UUID for CUSTOM, an s3:// URI for S3)
  const { documentId } = await store.add('User prefers aisle seats', {
    category: 'travel',
  })
  // --8<-- [end:search]

  void documentId
}
void searchAndAdd

// =====================
// Citing retrieved passages
// =====================

async function citations() {
  // --8<-- [start:citations]
  const store = new BedrockKnowledgeBaseStore({
    name: 'docs',
    config: { knowledgeBaseId: 'KB123' },
  })

  const passages = new Map<string, MemoryEntry>()

  const searchDocs = tool({
    name: 'search_docs',
    description: 'Search the product documentation and return passages to cite.',
    inputSchema: z.object({ query: z.string() }),
    callback: async ({ query }) => {
      const entries = await store.search(query, { maxSearchResults: 5 })
      return entries.map((entry) => {
        const name = `passage ${passages.size + 1}`
        passages.set(name, entry)
        return new DocumentBlock({
          name,
          format: 'txt',
          source: { content: [{ text: entry.content }] },
          citations: { enabled: true },
        })
      })
    },
  })

  const agent = new Agent({ model: new BedrockModel(), tools: [searchDocs] })
  const result = await agent.invoke('How do I factory reset the router?')

  for (const block of result.lastMessage.content) {
    if (block.type !== 'citationsBlock') continue
    for (const citation of block.citations) {
      const entry = passages.get(citation.title)
      console.log(citation.title, entry?.metadata?._sourceLocation)
    }
  }
  // --8<-- [end:citations]
}
void citations

// =====================
// Extraction
// =====================

function extraction() {
  // --8<-- [start:extraction]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    writable: true,
    extraction: true,
    config: { knowledgeBaseId: 'KB123', dataSourceType: 'CUSTOM', dataSourceId: 'DS456' },
  })
  // --8<-- [end:extraction]

  void store
}
void extraction
