import { Agent } from '@strands-agents/sdk'
import { Offload } from '@strands-agents/sdk/experimental'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'

async function basicConfig() {
  // --8<-- [start:basic_config]
  const agent = new Agent({
    contextManager: {
      strategies: [
        Offload.truncate('toolResults').when({
          threshold: 2000,
        }),
        Offload.summarize('*').when({
          utilization: 0.8,
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

async function nativeCompaction() {
  // --8<-- [start:native_compaction]
  const summarizer = new AnthropicModel({
    modelId: 'claude-haiku-5-5',
    // Opt in to on-demand compaction; the summary replaces message 0.
    modelInfo: { capabilities: { serverSideCompaction: true } },
  })
  const agent = new Agent({
    model: new AnthropicModel({ modelId: 'claude-sonnet-5-5' }),
    auxModel: summarizer,
    contextManager: {
      strategies: [
        Offload.summarize('*', {
          systemPrompt:
            'Summarize the conversation. Restate the original task word for word. Do not call tools.',
        }).when({ utilization: 0.7, preserveRecent: 3 }),
      ],
    },
  })
  // --8<-- [end:native_compaction]
  return agent
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
    contextManager: {
      stash: false,
    },
  })
  // --8<-- [end:stash_disabled]
}
