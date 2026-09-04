import {
  Agent,
  SlidingWindowConversationManager,
} from '@strands-agents/sdk'

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

async function customConversationManager() {
  // --8<-- [start:custom_conversation_manager]
  // Your conversation manager is used;
  // ContextOffloader is still added automatically
  const agent = new Agent({
    contextManager: 'auto',
    conversationManager:
      new SlidingWindowConversationManager({
        windowSize: 30,
      }),
  })
  // --8<-- [end:custom_conversation_manager]
}

async function disabled() {
  // --8<-- [start:disabled]
  const agent = new Agent({
    contextManager: false,
  })
  // --8<-- [end:disabled]
}
