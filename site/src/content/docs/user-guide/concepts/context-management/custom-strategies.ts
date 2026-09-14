import { Agent } from '@strands-agents/sdk'
import {
  ContextManager,
  Offload,
} from '@strands-agents/sdk/experimental'

async function basicConfig() {
  // --8<-- [start:basic_config]
  const agent = new Agent({
    contextManager: new ContextManager({
      strategies: [
        Offload.truncate('toolResults').when({
          threshold: 2000,
        }),
        Offload.summarize('*').when({
          utilization: 0.8,
          preserveRecent: 4,
        }),
      ],
    }),
  })
  // --8<-- [end:basic_config]
}

async function truncate() {
  // --8<-- [start:truncate]
  Offload.truncate('toolResults', {
    previewTokens: 750,
  }).when({ threshold: 1500 })
  // --8<-- [end:truncate]
}

async function summarize() {
  // --8<-- [start:summarize]
  Offload.summarize('*').when({
    utilization: 0.85,
    preserveRecent: 4,
  })
  // --8<-- [end:summarize]
}

async function drop() {
  // --8<-- [start:drop]
  Offload.drop('toolResults').when({
    preserveRecent: 5,
  })
  // --8<-- [end:drop]
}

async function conditions() {
  // --8<-- [start:conditions_threshold]
  Offload.truncate('toolResults').when({
    threshold: 2000,
  })
  // --8<-- [end:conditions_threshold]

  // --8<-- [start:conditions_utilization]
  Offload.summarize('*').when({
    utilization: 0.85,
    preserveRecent: 4,
  })
  // --8<-- [end:conditions_utilization]

  // --8<-- [start:conditions_both]
  Offload.truncate('toolResults').when({
    threshold: 1500,
    utilization: 0.9,
  })
  // --8<-- [end:conditions_both]
}

async function stash() {
  // --8<-- [start:stash_disabled]
  const agent = new Agent({
    contextManager: new ContextManager({
      stash: false,
    }),
  })
  // --8<-- [end:stash_disabled]
}
