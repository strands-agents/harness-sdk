// @ts-nocheck

// --8<-- [start:turn_on_writes_imports]
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { BedrockKnowledgeBaseStore } from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
// --8<-- [end:turn_on_writes_imports]

// --8<-- [start:multi_store_imports]
import { Agent, BedrockModel } from '@strands-agents/sdk'
import {
  BedrockKnowledgeBaseStore,
  type BedrockKnowledgeBaseConfig,
} from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
// --8<-- [end:multi_store_imports]

// --8<-- [start:search_tool_config_imports]
import { Agent, BedrockModel } from '@strands-agents/sdk'
import { BedrockKnowledgeBaseStore } from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
// --8<-- [end:search_tool_config_imports]

// --8<-- [start:extraction_defaults_imports]
import { BedrockKnowledgeBaseStore } from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
// --8<-- [end:extraction_defaults_imports]

// --8<-- [start:extraction_custom_imports]
import { InvocationTrigger, ModelExtractor, BedrockModel } from '@strands-agents/sdk'
import { BedrockKnowledgeBaseStore } from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
// --8<-- [end:extraction_custom_imports]

// --8<-- [start:custom_trigger_imports]
import { ExtractionTrigger, AfterInvocationEvent } from '@strands-agents/sdk'
import type { ExtractionTriggerContext } from '@strands-agents/sdk'
// --8<-- [end:custom_trigger_imports]

// --8<-- [start:injection_custom_imports]
import { Agent, BedrockModel, type MessageData } from '@strands-agents/sdk'
import { BedrockKnowledgeBaseStore } from '@strands-agents/sdk/vended-memory-stores/bedrock-knowledge-base'
// --8<-- [end:injection_custom_imports]

// --8<-- [start:custom_store_imports]
import type { MemoryStore, MemoryEntry, SearchOptions } from '@strands-agents/sdk'
// --8<-- [end:custom_store_imports]

// --8<-- [start:server_side_store_imports]
import type {
  MemoryStore,
  MemoryEntry,
  SearchOptions,
  MessageData,
  AddMessagesContext,
} from '@strands-agents/sdk'
// --8<-- [end:server_side_store_imports]
