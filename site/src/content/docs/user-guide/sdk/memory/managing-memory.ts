import {
  Agent,
  MemoryManager,
  InvocationTrigger,
  ModelExtractor,
  BedrockModel,
  ExtractionTrigger,
  AfterInvocationEvent,
} from '@strands-agents/sdk'
import type {
  MemoryStore,
  MemoryEntry,
  SearchOptions,
  MessageData,
  AddMessagesContext,
  ExtractionTriggerContext,
} from '@strands-agents/sdk'
import {
  BedrockKnowledgeBaseStore,
  type BedrockKnowledgeBaseConfig,
} from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'

// Stand-in for the reader's own managed backend, used by the server-side store example.
declare const myBackend: {
  retrieve(query: string, limit?: number): Promise<MemoryEntry[]>
  ingestConversation(messages: MessageData[]): Promise<void>
}

// =====================
// Turn on writes: add_memory tool + extraction, both with defaults
// =====================

function turnOnWrites() {
  // --8<-- [start:turn_on_writes]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    writable: true,
    extraction: true, // capture memories from the conversation, every 5 turns
    config: { knowledgeBaseId: 'KB123', dataSourceType: 'CUSTOM', dataSourceId: 'DS456' },
  })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: {
      stores: [store],
      addToolConfig: true, // let the agent save memories itself
    },
  })
  // --8<-- [end:turn_on_writes]

  void agent
}
void turnOnWrites

// =====================
// Multiple stores
// =====================

function multiStore() {
  // --8<-- [start:multi_store]
  // Build the connection once, vary only name and scope per store.
  const connection: BedrockKnowledgeBaseConfig = {
    knowledgeBaseId: 'KB123',
    dataSourceType: 'CUSTOM',
    dataSourceId: 'DS456',
  }

  const personal = new BedrockKnowledgeBaseStore({
    name: 'personal',
    description: 'Knowledge specific to this user.',
    writable: true,
    scope: 'user-abc',
    config: connection,
  })

  const team = new BedrockKnowledgeBaseStore({
    name: 'team',
    description: 'Shared team knowledge.',
    scope: 'team-xyz',
    config: connection,
  })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: { stores: [personal, team] },
  })
  // --8<-- [end:multi_store]

  void agent
}
void multiStore

// =====================
// Search tool configuration
// =====================

function searchToolConfig() {
  // --8<-- [start:search_tool_config]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    config: { knowledgeBaseId: 'KB123' },
  })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: {
      stores: [store],
      searchToolConfig: {
        name: 'recall',
        description: 'Look up what you remember about the user.',
      },
      // add_memory: opt in, and return as soon as writes dispatch instead of awaiting them
      addToolConfig: { waitForWrites: false },
    },
  })
  // --8<-- [end:search_tool_config]

  void agent
}
void searchToolConfig

// =====================
// Programmatic search and add
// =====================

async function programmatic(memoryManager: MemoryManager) {
  // --8<-- [start:programmatic]
  // Search every store, or a subset by name.
  const all = await memoryManager.search('travel plans')
  const scoped = await memoryManager.search('travel plans', {
    stores: ['personal'],
    maxSearchResults: 5,
  })

  // Write to writable stores, with metadata.
  await memoryManager.add('Prefers aisle seats', {
    stores: ['personal'],
    metadata: { category: 'travel' },
  })
  // --8<-- [end:programmatic]

  void all
  void scoped
}
void programmatic

// =====================
// Flush pending writes at shutdown
// =====================

async function flushExample(memoryManager: MemoryManager) {
  // --8<-- [start:flush]
  // At a shutdown boundary you control, before the process exits.
  process.on('beforeExit', async () => {
    await memoryManager.flush()
  })
  // --8<-- [end:flush]
}
void flushExample

// =====================
// Extraction: enable with defaults
// =====================

function extractionDefaults() {
  // --8<-- [start:extraction_defaults]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    writable: true,
    extraction: true, // extract every 5 turns with a ModelExtractor
    config: { knowledgeBaseId: 'KB123', dataSourceType: 'CUSTOM', dataSourceId: 'DS456' },
  })
  // --8<-- [end:extraction_defaults]

  void store
}
void extractionDefaults

// =====================
// Extraction: custom trigger and extractor
// =====================

function extractionCustom() {
  // --8<-- [start:extraction_custom]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    writable: true,
    extraction: {
      trigger: new InvocationTrigger(), // after every turn, not every 5
      extractor: new ModelExtractor({
        model: new BedrockModel(), // a cheaper model than the agent's to cut cost
        systemPrompt: 'Extract durable user preferences as discrete facts.',
      }),
    },
    config: { knowledgeBaseId: 'KB123', dataSourceType: 'CUSTOM', dataSourceId: 'DS456' },
  })
  // --8<-- [end:extraction_custom]

  void store
}
void extractionCustom

// =====================
// Extraction: custom trigger
// =====================

// --8<-- [start:custom_trigger]
// Extract only after a tool has flagged extraction
class CustomTrigger extends ExtractionTrigger {
  readonly name = 'custom-trigger'

  attach(context: ExtractionTriggerContext): void {
    context.agent.addHook(AfterInvocationEvent, () => {
      if (context.agent.appState.get('extract')) {
        context.fire()
      }
    })
  }
}
// --8<-- [end:custom_trigger]

void CustomTrigger

// =====================
// Injection: customized
// =====================

function injectionCustom() {
  // --8<-- [start:injection_custom]
  const store = new BedrockKnowledgeBaseStore({
    name: 'preferences',
    config: { knowledgeBaseId: 'KB123' },
  })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: {
      stores: [store],
      injection: {
        // 'userTurn' (default), 'everyTurn', or a predicate over the conversation
        trigger: ({ messages }) => messages.length >= 4,
        maxEntries: 3,
        query: ({ messages }: { messages: MessageData[] }) => {
          const block = messages.at(-1)?.content[0]
          return block && 'text' in block ? block.text : undefined
        },
        format: ({ entries }) => entries.map((entry) => `- ${entry.content}`).join('\n'),
      },
    },
  })
  // --8<-- [end:injection_custom]

  void agent
}
void injectionCustom

// =====================
// Custom store
// =====================

// --8<-- [start:custom_store]
class InMemoryStore implements MemoryStore {
  readonly name = 'preferences'
  readonly writable = true
  private readonly _entries: string[] = []

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    const limit = options?.maxSearchResults ?? 3
    return this._entries
      .filter((content) => content.includes(query))
      .slice(0, limit)
      .map((content) => ({ content }))
  }

  async add(content: string): Promise<void> {
    this._entries.push(content)
  }
}
// --8<-- [end:custom_store]

void InMemoryStore

// =====================
// Server-side extraction store (addMessages sink)
// =====================

// --8<-- [start:server_side_store]
class ServerSideStore implements MemoryStore {
  readonly name = 'preferences'
  readonly writable = true
  // Extract every 5 turns; no extractor, so the manager calls addMessages.
  readonly extraction = true

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    return myBackend.retrieve(query, options?.maxSearchResults)
  }

  // The manager hands the raw message batch here; the backend extracts server-side.
  async addMessages(
    messages: MessageData[],
    context?: AddMessagesContext
  ): Promise<void> {
    await myBackend.ingestConversation(messages)
  }
}
// --8<-- [end:server_side_store]

void ServerSideStore
