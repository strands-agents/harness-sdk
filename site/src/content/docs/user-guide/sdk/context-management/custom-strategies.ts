import { Agent } from '@strands-agents/sdk'
import { Offload } from '@strands-agents/sdk/context-manager'

async function basicConfig() {
  // --8<-- [start:basic_config]
  const agent = new Agent({
    contextManager: {
      strategies: [
        Offload.truncate('toolResults').when({
          blockThreshold: 2000,
        }),
        Offload.summarize('*').when({
          contextUtilization: '80%',
          preserveRecent: 4,
        }),
      ],
    },
  })
  // --8<-- [end:basic_config]
}

async function truncate() {
  // --8<-- [start:truncate]
  Offload.truncate('toolResults', {
    previewTokens: 750,
  }).when({ blockThreshold: 1500 })
  // --8<-- [end:truncate]
}

async function summarize() {
  // --8<-- [start:summarize]
  Offload.summarize('*').when({
    contextUtilization: '85%',
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
    blockThreshold: 2000,
  })
  // --8<-- [end:conditions_threshold]

  // --8<-- [start:conditions_utilization]
  Offload.summarize('*').when({
    contextUtilization: '85%',
    preserveRecent: 4,
  })
  // --8<-- [end:conditions_utilization]

  // --8<-- [start:conditions_both]
  Offload.truncate('toolResults').when({
    blockThreshold: 1500,
    contextUtilization: '90%',
  })
  // --8<-- [end:conditions_both]
}

async function archive() {
  // --8<-- [start:archive_disabled]
  const agent = new Agent({
    contextManager: {
      archive: false,
    },
  })
  // --8<-- [end:archive_disabled]
}
