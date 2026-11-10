import { Agent, tool } from '@strands-agents/sdk'
import type { ToolContext } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import { z } from 'zod'

// --8<-- [start:conversation_manager_import]

import { SlidingWindowConversationManager } from '@strands-agents/sdk'

// --8<-- [end:conversation_manager_import]

// Conversation history example
async function conversationHistoryExample() {
  // --8<-- [start:conversation_history]
  // Create an agent
  const agent = new Agent()

  // Send a message and get a response
  await agent.invoke('Hello!')

  // Access the conversation history
  console.log(agent.messages) // Shows all messages exchanged so far
  // --8<-- [end:conversation_history]
}

// Message initialization example
async function messageInitializationExample() {
  // --8<-- [start:message_initialization]
  // Create an agent with initial messages
  const agent = new Agent({
    messages: [
      { role: 'user', content: [{ text: 'Hello, my name is Strands!' }] },
      { role: 'assistant', content: [{ text: 'Hi there! How can I help you today?' }] },
    ],
  })

  // Continue the conversation
  await agent.invoke("What's my name?")
  // --8<-- [end:message_initialization]
}

async function directToolCallingExample() {
  // --8<-- [start:direct_tool_calling]
  const agent = new Agent({
    tools: [notebook],
  })

  // notebook is registered when the agent is created, so the non-null assertion is safe.
  await agent.tool.notebook!.invoke({ mode: 'list' })
  const recordedMessageCount = agent.messages.length

  await agent.tool.notebook!.invoke({ mode: 'list' }, { recordDirectToolCall: false })

  console.log(recordedMessageCount > 0) // true
  console.log(agent.messages.length === recordedMessageCount) // true
  // --8<-- [end:direct_tool_calling]
}

// conversation_manager example
async function conversationManagerExample() {
  // --8<-- [start:conversation_manager]
  // Create a conversation manager with custom window size
  // By default, SlidingWindowConversationManager is used even if not specified
  const conversationManager = new SlidingWindowConversationManager({
    windowSize: 10,
  })

  const agent = new Agent({
    conversationManager,
  })
  // --8<-- [end:conversation_manager]
}

// Agent state basic usage example
async function agentStateBasicExample() {
  // --8<-- [start:agent_state_basic]
  // Create an agent with initial state
  const agent = new Agent({
    appState: { user_preferences: { theme: 'dark' }, session_count: 0 },
  })

  // Access state values
  const theme = agent.appState.get('user_preferences')
  console.log(theme) // { theme: 'dark' }

  // Set new state values
  agent.appState.set('last_action', 'login')
  agent.appState.set('session_count', 1)

  // Get state values individually
  console.log(agent.appState.get('user_preferences'))
  console.log(agent.appState.get('session_count'))

  // Delete state values
  agent.appState.delete('last_action')
  // --8<-- [end:agent_state_basic]
}

// State validation example
async function stateValidationExample() {
  // --8<-- [start:state_validation]
  const agent = new Agent()

  // Valid JSON-serializable values
  agent.appState.set('string_value', 'hello')
  agent.appState.set('number_value', 42)
  agent.appState.set('boolean_value', true)
  agent.appState.set('list_value', [1, 2, 3])
  agent.appState.set('dict_value', { nested: 'data' })
  agent.appState.set('null_value', null)

  // Invalid values will raise an error
  try {
    agent.appState.set('function', () => 'test') // Not JSON serializable
  } catch (error) {
    console.log(`Error: ${error}`)
  }
  // --8<-- [end:state_validation]
}

// State in tools example
async function stateInToolsExample() {
  // --8<-- [start:state_in_tools]
  const trackUserActionTool = tool({
    name: 'track_user_action',
    description: 'Track user actions in agent state',
    inputSchema: z.object({
      action: z.string().describe('The action to track'),
    }),
    callback: (input, context?: ToolContext) => {
      if (!context) {
        throw new Error('Context is required')
      }

      // Get current action count
      const actionCount = (context.agent.appState.get('action_count') as number) || 0

      // Update state
      context.agent.appState.set('action_count', actionCount + 1)
      context.agent.appState.set('last_action', input.action)

      return `Action '${input.action}' recorded. Total actions: ${actionCount + 1}`
    },
  })

  const getUserStatsTool = tool({
    name: 'get_user_stats',
    description: 'Get user statistics from agent state',
    inputSchema: z.object({}),
    callback: (input, context?: ToolContext) => {
      if (!context) {
        throw new Error('Context is required')
      }

      const actionCount = (context.agent.appState.get('action_count') as number) || 0
      const lastAction = (context.agent.appState.get('last_action') as string) || 'none'

      return `Actions performed: ${actionCount}, Last action: ${lastAction}`
    },
  })

  // Create agent with tools
  const agent = new Agent({
    tools: [trackUserActionTool, getUserStatsTool],
  })

  // Use tools that modify and read state
  await agent.invoke('Track that I logged in')
  await agent.invoke('Track that I viewed my profile')
  console.log(`Actions taken: ${agent.appState.get('action_count')}`)
  console.log(`Last action: ${agent.appState.get('last_action')}`)
  // --8<-- [end:state_in_tools]
}

// Invocation state example
async function invocationStateExample() {
  // --8<-- [start:invocation_state]
  const agent = new Agent()

  // Pass per-invocation state when invoking
  const result = await agent.invoke('Hi there!', {
    invocationState: { requestId: 'r-42', userId: 'u-1' },
  })

  // Hooks and tools can read and mutate invocationState during
  // the invocation. The same object is returned on the result.
  console.log(result.invocationState)
  // { requestId: 'r-42', userId: 'u-1', ... }
  // --8<-- [end:invocation_state]
}
