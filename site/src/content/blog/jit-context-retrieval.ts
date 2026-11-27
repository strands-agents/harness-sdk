import { Agent } from '@strands-agents/sdk'
import { Offload } from '@strands-agents/sdk/context-manager'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { Bm25SearchStrategy } from '@strands-agents/sdk/storage/search/bm25'

function offloadStrategiesExample() {
  // --8<-- [start:offload_strategies]
  const agent = new Agent({
    contextManager: {
      strategies: [
        // Bulky tool output collapses to a head/tail preview once a block exceeds 1,500 tokens
        Offload.truncate('toolResults', { previewTokens: 750 }).when({ blockThreshold: 1500 }),
        // Conversation history condenses into a summary once the window is 85% full
        Offload.summarize('*').when({ contextUtilization: '85%', preserveRecent: 4 }),
      ],
    },
  })
  // --8<-- [end:offload_strategies]
  return agent
}

function archiveExample() {
  // --8<-- [start:archive]
  // The archive needs no configuration: it is on by default, and falls back to the
  // agent's own storage, then to in-memory. Name a backend to make it durable.
  const agent = new Agent({
    contextManager: {
      archive: { storage: new LocalFileStorage() },
    },
  })
  // --8<-- [end:archive]
  return agent
}

function searchStrategyExample() {
  // --8<-- [start:search_strategy]
  // Indexed on write, ranked best-first on read
  const storage = new LocalFileStorage('./.strands/artifacts', {
    searchStrategy: new Bm25SearchStrategy(),
  })
  // --8<-- [end:search_strategy]
  return storage
}

function isolationExample() {
  // --8<-- [start:isolation]
  const storage = new LocalFileStorage('./.strands')

  const researcher = new Agent({
    id: 'researcher',
    storage: storage.namespace('researcher'),
    contextManager: 'auto',
  })

  const writer = new Agent({
    id: 'writer',
    storage: storage.namespace('writer'),
    contextManager: 'auto',
  })
  // --8<-- [end:isolation]
  return { researcher, writer }
}

export { offloadStrategiesExample, archiveExample, searchStrategyExample, isolationExample }
