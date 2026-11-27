import { Agent, BedrockModel } from '@strands-agents/sdk'
import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'

// =====================
// Getting Started (minimal happy path)
// =====================

function gettingStarted() {
  // --8<-- [start:getting_started]
  // Persists to ~/.strands/memory/notes.json by default.
  const store = new TestMemoryStore({ name: 'notes' })

  const agent = new Agent({
    model: new BedrockModel(),
    memoryManager: { stores: [store] },
  })
  // --8<-- [end:getting_started]

  void agent
}
void gettingStarted
