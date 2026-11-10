// @ts-nocheck

// --8<-- [start:null_conversation_manager_imports]
import { Agent, NullConversationManager } from '@strands-agents/sdk'
// --8<-- [end:null_conversation_manager_imports]

// --8<-- [start:sliding_window_conversation_manager_imports]
import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk'
// --8<-- [end:sliding_window_conversation_manager_imports]

// --8<-- [start:custom_conversation_manager_imports]
import {
  Agent,
  ConversationManager,
  type ConversationManagerReduceOptions,
} from '@strands-agents/sdk'
// --8<-- [end:custom_conversation_manager_imports]

// --8<-- [start:custom_conversation_manager_proactive_imports]
import {
  Agent,
  ConversationManager,
  AfterInvocationEvent,
  type AgentData,
  type ConversationManagerReduceOptions,
} from '@strands-agents/sdk'
// --8<-- [end:custom_conversation_manager_proactive_imports]

// --8<-- [start:summarizing_conversation_manager_basic_imports]
import { Agent, SummarizingConversationManager } from '@strands-agents/sdk'
// --8<-- [end:summarizing_conversation_manager_basic_imports]

// --8<-- [start:summarizing_conversation_manager_custom_imports]
import { Agent, SummarizingConversationManager, BedrockModel } from '@strands-agents/sdk'
// --8<-- [end:summarizing_conversation_manager_custom_imports]

// --8<-- [start:summarizing_conversation_manager_system_prompt_imports]
import { Agent, SummarizingConversationManager } from '@strands-agents/sdk'
// --8<-- [end:summarizing_conversation_manager_system_prompt_imports]

// --8<-- [start:summarizing_conversation_manager_advanced_imports]
import { Agent, SummarizingConversationManager } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
// --8<-- [end:summarizing_conversation_manager_advanced_imports]

// --8<-- [start:proactive_sliding_window_imports]
import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk'
// --8<-- [end:proactive_sliding_window_imports]

// --8<-- [start:proactive_summarizing_imports]
import { Agent, SummarizingConversationManager } from '@strands-agents/sdk'
// --8<-- [end:proactive_summarizing_imports]

// --8<-- [start:pin_first_imports]
import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk'
// --8<-- [end:pin_first_imports]
