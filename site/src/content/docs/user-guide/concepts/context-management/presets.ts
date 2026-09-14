import { Agent } from '@strands-agents/sdk'
import { Offload } from '@strands-agents/sdk/experimental'

async function usingPresets() {
  // --8<-- [start:using_presets]
  const agent = new Agent({
    contextManager: {
      strategies: [
        'proactiveSummarization',
        'largeToolOffloading',
      ],
    },
  })
  // --8<-- [end:using_presets]
}

async function mixing() {
  // --8<-- [start:mixing]
  const agent = new Agent({
    contextManager: {
      strategies: [
        'largeToolOffloading',
        Offload.summarize('*').when({
          utilization: 0.9,
          preserveRecent: 2,
        }),
      ],
    },
  })
  // --8<-- [end:mixing]
}
