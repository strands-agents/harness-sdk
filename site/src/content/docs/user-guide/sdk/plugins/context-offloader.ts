import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { InMemoryStorage, LocalFileStorage, S3Storage } from '@strands-agents/sdk/storage'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'

// =====================
// Disable Retrieval Tool
// =====================

{
  // --8<-- [start:disable_retrieval_tool]
  const agent = new Agent({
    tools: [bash, fileEditor],
    plugins: [
      new ContextOffloader({
        storage: new LocalFileStorage('./artifacts/'),
        includeRetrievalTool: false,
      }),
    ],
  })
  // --8<-- [end:disable_retrieval_tool]

  void agent
}

// =====================
// Getting Started
// =====================

{
  // --8<-- [start:getting_started]
  const agent = new Agent({
    plugins: [new ContextOffloader({ storage: new InMemoryStorage() })],
  })
  // --8<-- [end:getting_started]

  void agent
}

// =====================
// Custom Thresholds
// =====================

{
  // --8<-- [start:custom_thresholds]
  const agent = new Agent({
    plugins: [
      new ContextOffloader({
        storage: new InMemoryStorage(),
        maxResultTokens: 5_000,
        previewTokens: 2_000,
      }),
    ],
  })
  // --8<-- [end:custom_thresholds]

  void agent
}

// =====================
// In-Memory Storage
// =====================

{
  // --8<-- [start:in_memory_storage]
  const agent = new Agent({
    plugins: [new ContextOffloader({ storage: new InMemoryStorage() })],
  })

  // Custom eviction window
  const agent2 = new Agent({
    plugins: [
      new ContextOffloader({
        storage: new InMemoryStorage(),
        evictAfterCycles: 50,
      }),
    ],
  })

  // Disable eviction
  const agent3 = new Agent({
    plugins: [
      new ContextOffloader({
        storage: new InMemoryStorage(),
        evictAfterCycles: null,
      }),
    ],
  })
  // --8<-- [end:in_memory_storage]

  void agent
  void agent2
  void agent3
}

// =====================
// Local File Storage
// =====================

{
  // --8<-- [start:local_file_storage]
  const agent = new Agent({
    plugins: [
      new ContextOffloader({
        storage: new LocalFileStorage('./artifacts/'),
      }),
    ],
  })
  // --8<-- [end:local_file_storage]

  void agent
}

// =====================
// S3 Storage
// =====================

{
  // --8<-- [start:s3_storage]
  const agent = new Agent({
    plugins: [
      new ContextOffloader({
        storage: new S3Storage('my-agent-artifacts', {
          prefix: 'tool-results/',
        }),
      }),
    ],
  })
  // --8<-- [end:s3_storage]

  void agent
}
