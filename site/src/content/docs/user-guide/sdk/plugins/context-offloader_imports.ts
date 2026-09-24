// @ts-nocheck
// Import snippets — intentionally repeat imports across blocks so each
// rendered doc example is self-contained.

// --8<-- [start:disable_retrieval_tool]
import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
// --8<-- [end:disable_retrieval_tool]

// --8<-- [start:getting_started]
import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:getting_started]

// --8<-- [start:custom_thresholds]
import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:custom_thresholds]

// --8<-- [start:in_memory_storage]
import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:in_memory_storage]

// --8<-- [start:local_file_storage]
import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
// --8<-- [end:local_file_storage]

// --8<-- [start:s3_storage]
import { Agent } from '@strands-agents/sdk'
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { S3Storage } from '@strands-agents/sdk/storage'
// --8<-- [end:s3_storage]
