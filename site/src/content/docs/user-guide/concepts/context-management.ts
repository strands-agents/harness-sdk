import { Agent, BedrockModel, Offload } from '@strands-agents/sdk'
import { LocalFileStorage, S3Storage } from '@strands-agents/sdk/storage'

async function basic() {
  // --8<-- [start:basic]
  const agent = new Agent({
    contextManager: 'auto',
  })
  // --8<-- [end:basic]
}

async function agentic() {
  // --8<-- [start:agentic]
  const agent = new Agent({
    contextManager: 'agentic',
  })
  // --8<-- [end:agentic]
}

async function explicit() {
  // --8<-- [start:explicit]
  const agent = new Agent({
    contextManager: {
      strategies: [
        // Offload large tool results; keep a 500-token preview in context
        Offload.truncate('toolResults', { previewTokens: 500 }).when({ threshold: 2500 }),
        // Summarize older messages when the window reaches 85% utilization
        Offload.summarize('*').when({ utilization: 0.85, preserveRecent: 2 }),
      ],
      // Stash keeps originals and registers a retrieve_context tool.
      // Omit for in-memory storage, or provide durable storage.
      stash: { storage: new LocalFileStorage('./artifacts/') },
    },
  })
  // --8<-- [end:explicit]
}

async function presets() {
  // --8<-- [start:presets]
  const agent = new Agent({
    contextManager: {
      strategies: ['largeToolOffloading', 'proactiveSummarization'],
    },
  })
  // --8<-- [end:presets]
}

async function customSummarizationModel() {
  // --8<-- [start:custom_summary_model]
  const agent = new Agent({
    contextManager: {
      strategies: [
        Offload.summarize('*', {
          model: new BedrockModel({ modelId: 'us.amazon.nova-lite-v1:0' }),
          systemPrompt: 'Summarize preserving tool outputs, errors, and IDs.',
        }).when({ utilization: 0.85, preserveRecent: 2 }),
      ],
      stash: false,
    },
  })
  // --8<-- [end:custom_summary_model]
}

async function storageBackends() {
  // --8<-- [start:storage_backends]
  // Local filesystem
  const stashLocal = { storage: new LocalFileStorage('./artifacts/') }

  // S3, using ambient AWS credentials
  const stashS3 = { storage: new S3Storage('my-bucket', { prefix: 'agent-stash/' }) }
  // --8<-- [end:storage_backends]
}
