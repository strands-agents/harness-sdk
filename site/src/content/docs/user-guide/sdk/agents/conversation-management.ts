import {
  Agent,
  ConversationManager,
  AfterInvocationEvent,
  NullConversationManager,
  SlidingWindowConversationManager,
  SummarizingConversationManager,
  BedrockModel,
} from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import type { LocalAgent, ConversationManagerReduceOptions } from '@strands-agents/sdk'

async function nullConversationManagerAgent() {
  // --8<-- [start:null_conversation_manager]
  const agent = new Agent({
    conversationManager: new NullConversationManager(),
  })
  // --8<-- [end:null_conversation_manager]
}

async function slidingWindowConversationManagerAgent() {
  // --8<-- [start:sliding_window_conversation_manager]
  // Create a conversation manager with custom window size
  const conversationManager = new SlidingWindowConversationManager({
    windowSize: 40, // Maximum number of messages to keep
    shouldTruncateResults: true, // Enable truncating the tool result when a message is too large for the model's context window
  })

  const agent = new Agent({
    conversationManager,
  })
  // --8<-- [end:sliding_window_conversation_manager]
}

// --8<-- [start:custom_conversation_manager]
class Last10MessagesManager extends ConversationManager {
  readonly name = 'my:last-10-messages'

  reduce({ agent }: ConversationManagerReduceOptions): boolean {
    if (agent.messages.length <= 10) return false
    agent.messages.splice(0, agent.messages.length - 10)
    return true
  }
}

const agent = new Agent({
  conversationManager: new Last10MessagesManager(),
})
// --8<-- [end:custom_conversation_manager]

// --8<-- [start:custom_conversation_manager_proactive]
class MyManager extends ConversationManager {
  readonly name = 'my:manager'
  private readonly _maxMessages = 5

  reduce({ agent }: ConversationManagerReduceOptions): boolean {
    return this._trim(agent.messages)
  }

  override initAgent(agent: LocalAgent): void {
    super.initAgent(agent) // preserves overflow recovery
    agent.addHook(AfterInvocationEvent, (event) => {
      this._trim(event.agent.messages)
    })
  }

  private _trim(messages: LocalAgent['messages']): boolean {
    if (messages.length <= this._maxMessages) return false
    messages.splice(0, messages.length - this._maxMessages)
    return true
  }
}
// --8<-- [end:custom_conversation_manager_proactive]

async function summarizingBasic() {
  // --8<-- [start:summarizing_conversation_manager_basic]
  const agent = new Agent({
    conversationManager: new SummarizingConversationManager(),
  })
  // --8<-- [end:summarizing_conversation_manager_basic]
}

async function summarizingCustom() {
  // --8<-- [start:summarizing_conversation_manager_custom]
  // Optionally use a different model for summarization
  const summarizationModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
  })

  const conversationManager = new SummarizingConversationManager({
    model: summarizationModel, // Override the agent's model for summarization
    summaryRatio: 0.3, // Summarize and replace the oldest 30% of messages
    preserveRecentMessages: 10, // Always keep 10 most recent messages
  })

  const agent = new Agent({
    conversationManager,
  })
  // --8<-- [end:summarizing_conversation_manager_custom]
}

async function summarizingAdvanced() {
  // --8<-- [start:summarizing_conversation_manager_advanced]
  // Use a cheaper, faster model for summarization tasks
  const summarizationModel = new AnthropicModel({
    modelId: 'claude-haiku-4-5-20251001',
    maxTokens: 1000,
    params: { temperature: 0.1 }, // Low temperature for consistent summaries
  })

  const conversationManager = new SummarizingConversationManager({
    model: summarizationModel,
    summaryRatio: 0.4,
    preserveRecentMessages: 8,
  })

  const agent = new Agent({
    conversationManager,
  })
  // --8<-- [end:summarizing_conversation_manager_advanced]
}

async function summarizingSystemPrompt() {
  // --8<-- [start:summarizing_conversation_manager_system_prompt]
  // Custom system prompt for technical conversations
  const customSystemPrompt = `
You are summarizing a technical conversation.
Create a concise bullet-point summary that:
- Focuses on code changes, architectural decisions, and technical solutions
- Preserves specific function names, file paths, and configuration details
- Omits conversational elements and focuses on actionable information
- Uses technical terminology appropriate for software development

Format as bullet points without conversational language.
`

  const conversationManager = new SummarizingConversationManager({
    summarizationSystemPrompt: customSystemPrompt,
  })

  const agent = new Agent({
    conversationManager,
  })
  // --8<-- [end:summarizing_conversation_manager_system_prompt]
}

async function proactiveSlidingWindow() {
  // --8<-- [start:proactive_sliding_window]
  const agent = new Agent({
    conversationManager: new SlidingWindowConversationManager({
      windowSize: 50,
      proactiveCompression: { compressionThreshold: 0.7 },
    }),
  })
  // --8<-- [end:proactive_sliding_window]
}

async function proactiveSummarizing() {
  // --8<-- [start:proactive_summarizing]
  const agent = new Agent({
    conversationManager: new SummarizingConversationManager({
      proactiveCompression: true,
    }),
  })
  // --8<-- [end:proactive_summarizing]
}

async function pinFirstExample() {
  // --8<-- [start:pin_first]
  const agent = new Agent({
    conversationManager: new SlidingWindowConversationManager({
      windowSize: 40,
      pinFirst: 1,
    }),
  })
  // --8<-- [end:pin_first]
}
