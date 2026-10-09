import { Agent, tool } from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import type { AgentStreamEvent } from '@strands-agents/sdk'
import { z } from 'zod'

// Quick Examples - Async Iterator Pattern
async function quickExampleAsyncIterator() {
  // --8<-- [start:quick_example_async_iterator]
  const agent = new Agent({ tools: [notebook] })

  for await (const event of agent.stream('Calculate 2+2')) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta.type === 'textDelta'
    ) {
      // Print out the model text delta event data
      process.stdout.write(event.event.delta.text)
    }
  }
  console.log('\nDone!')
  // --8<-- [end:quick_example_async_iterator]
}

// Agent Loop Lifecycle Example - Shared processor
async function agentLoopLifecycleExample() {
  const agent = new Agent({ tools: [notebook], printer: false })

  // --8<-- [start:agent_loop_lifecycle]
  function processEvent(event: AgentStreamEvent): void {
    // Track agent loop lifecycle
    switch (event.type) {
      case 'beforeInvocationEvent':
        console.log('Agent loop initialized')
        break
      case 'beforeModelCallEvent':
        console.log('Agent loop cycle starting')
        break
      case 'afterModelCallEvent':
        console.log(`New message created: ${event.stopData?.message.role}`)
        break
      case 'beforeToolsEvent':
        console.log('About to execute tool!')
        break
      case 'afterToolsEvent':
        console.log('Finished executing tool!')
        break
      case 'afterInvocationEvent':
        console.log('Agent loop completed')
        break
    }

    // Track tool usage
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockStartEvent' &&
      event.event.start?.type === 'toolUseStart'
    ) {
      console.log(`\nUsing tool: ${event.event.start.name}`)
    }

    // Show text snippets
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta.type === 'textDelta'
    ) {
      process.stdout.write(event.event.delta.text)
    }
  }
  const responseGenerator = agent.stream(
    'What is the capital of France and what is 42+7? Record in the notebook.'
  )
  for await (const event of responseGenerator) {
    processEvent(event)
  }
  // --8<-- [end:agent_loop_lifecycle]
}

// Sub-Agent Streaming Example - Using agents as tools
async function subAgentStreamingExample() {
  // --8<-- [start:sub_agent_basic]

  // Create the math agent
  const mathAgent = new Agent({
    systemPrompt: 'You are a math expert. Answer a math problem in one sentence',
    printer: false,
  })

  const calculator = tool({
    name: 'mathAgent',
    description: 'Agent that calculates the answer to a math problem input.',
    inputSchema: z.object({ input: z.string() }),
    callback: async function* (input): AsyncGenerator<string, string, unknown> {
      // Stream from the sub-agent
      const generator = mathAgent.stream(input.input)
      let result = await generator.next()
      while (!result.done) {
        // Process events from the sub-agent
        if (
          result.value.type === 'modelStreamUpdateEvent' &&
          result.value.event.type === 'modelContentBlockDeltaEvent' &&
          result.value.event.delta.type === 'textDelta'
        ) {
          yield result.value.event.delta.text
        }
        result = await generator.next()
      }
      return result.value.lastMessage.content[0]!.type === 'textBlock'
        ? result.value.lastMessage.content[0]!.text
        : result.value.lastMessage.content[0]!.toString()
    },
  })

  const agent = new Agent({ tools: [calculator] })
  for await (const event of agent.stream('What is 2 * 3? Use your tool.')) {
    if (event.type === 'toolStreamUpdateEvent') {
      console.log(`Tool Event: ${JSON.stringify(event.event.data)}`)
    }
  }
  console.log('\nDone!')

  // --8<-- [end:sub_agent_basic]
}

// Event Serialization Example
async function eventSerializationExample() {
  const agent = new Agent()

  // --8<-- [start:event_serialization]
  for await (const event of agent.stream('Hello')) {
    switch (event.type) {
      // Forward text deltas for real-time display
      case 'modelStreamUpdateEvent':
        if (
          event.event.type === 'modelContentBlockDeltaEvent' &&
          event.event.delta.type === 'textDelta'
        ) {
          console.log(
            `data: ${JSON.stringify({ type: 'text', text: event.event.delta.text })}`
          )
        }
        break

      // Forward tool names for progress indicators
      case 'beforeToolCallEvent':
        console.log(`data: ${JSON.stringify({ type: 'tool', name: event.toolUse.name })}`)
        break

      // Forward the final result
      case 'agentResultEvent':
        console.log(`data: ${JSON.stringify(event)}`)
        break
    }
  }
  // --8<-- [end:event_serialization]
}
