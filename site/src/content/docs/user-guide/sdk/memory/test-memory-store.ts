import { Agent, BedrockModel } from '@strands-agents/sdk'
import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'

// =====================
// Basic: persists to disk by default
// =====================

function basic() {
  // --8<-- [start:basic]
  // Persists to ~/.strands/memory/notes.json by default. Survives restarts.
  const store = new TestMemoryStore({ name: 'notes' })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: { stores: [store] },
  })
  // --8<-- [end:basic]

  void agent
}
void basic

// =====================
// Persistence: ephemeral and explicit path
// =====================

function persistence() {
  // --8<-- [start:persistence]
  // Ephemeral: nothing is written to disk, and a fresh instance forgets everything.
  const scratch = new TestMemoryStore({ name: 'notes', persist: false })

  // Explicit file location instead of the default under ~/.strands/memory/.
  const project = new TestMemoryStore({ name: 'notes', path: './notes.json' })
  // --8<-- [end:persistence]

  void scratch
  void project
}
void persistence

// =====================
// Search and add
// =====================

async function searchAndAdd() {
  // --8<-- [start:search_and_add]
  const store = new TestMemoryStore({ name: 'notes' })

  // add returns the id of the stored (or already-present, on dedup) record.
  const { id } = await store.add('User prefers aisle seats', { category: 'travel' })

  const results = await store.search('which seats does the user prefer?')
  for (const entry of results) {
    console.log(entry.content, entry.metadata?._relevanceScore)
  }
  // --8<-- [end:search_and_add]

  void id
}
void searchAndAdd

// =====================
// Extraction
// =====================

function extraction() {
  // --8<-- [start:extraction]
  const store = new TestMemoryStore({
    name: 'notes',
    extraction: true, // distill facts from the conversation, every 5 turns
  })
  // --8<-- [end:extraction]

  void store
}
void extraction
