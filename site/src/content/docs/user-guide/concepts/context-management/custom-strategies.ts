import {
  Agent,
  ContextManager,
  Offload,
} from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'

async function customStrategies() {
  // --8<-- [start:custom_strategies]
  const agent = new Agent({
    contextManager: new ContextManager({
      strategies: [
        // Truncate tool results over 2500 tokens
        Offload.truncate('toolResults')
          .when({ threshold: 2500 }),

        // Summarize oldest messages at 85% utilization
        Offload.summarize('*')
          .when({ utilization: 0.85 }),
      ],
    }),
  })
  // --8<-- [end:custom_strategies]
}

async function stash() {
  // --8<-- [start:stash]
  const agent = new Agent({
    contextManager: new ContextManager({
      strategies: [
        Offload.truncate('toolResults')
          .when({ threshold: 2500 }),
      ],
      stash: {
        storage: new LocalFileStorage(
          '/tmp/agent-stash'
        ),
      },
    }),
  })
  // --8<-- [end:stash]
}
