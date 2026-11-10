import { Agent, BedrockModel, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a specific location.',
  inputSchema: z.object({
    location: z.string().describe('The city and state, e.g., San Francisco, CA'),
  }),
  callback: (input) => {
    const fakeWeatherData = {
      temperature: '72°F',
      conditions: 'sunny',
    }

    return `The weather in ${input.location} is ${fakeWeatherData.temperature} and ${fakeWeatherData.conditions}.`
  },
})

/**
 * Helper function to demonstrate the simple invoke() pattern.
 * This is the recommended approach for most use cases.
 * @param title The title of the scenario to be logged.
 * @param agent The agent instance to use.
 * @param prompt The user prompt to invoke the agent with.
 */
async function runInvoke(title: string, agent: Agent, prompt: string) {
  console.log(`--- ${title} ---`)
  console.log(`User: ${prompt}`)

  const result = await agent.invoke(prompt)

  console.log(`\n::Invocation complete; stop reason was ${result.stopReason}\n`)
}

/**
 * Helper function to demonstrate the stream() pattern.
 * Use this when you need access to intermediate streaming events.
 * @param title The title of the scenario to be logged.
 * @param agent The agent instance to use.
 * @param prompt The user prompt to invoke the agent with.
 */
async function runStreaming(title: string, agent: Agent, prompt: string) {
  console.log(`--- ${title} ---`)
  console.log(`User: ${prompt}`)

  console.log('Agent response stream:')
  for await (const event of agent.stream(prompt)) {
    console.log('[Event]', event.type)
  }

  console.log('\nStreaming complete.\n')
}

async function main() {
  // 1. Initialize the components
  const model = new BedrockModel()

  // 2. Create agents
  const defaultAgent = new Agent()
  const agentWithoutTools = new Agent({ model })
  const agentWithTools = new Agent({
    systemPrompt:
      'You are a helpful assistant that provides weather information using the get_weather tool. Always Inform the user if you run tools.',
    model,
    tools: [weatherTool],
  })

  // Demonstrate the simple invoke() pattern (recommended for most use cases)
  console.log('=== Simple invoke() pattern ===\n')
  await runInvoke('0: Invocation with default agent (no model or tools)', defaultAgent, 'Hello!')
  await runInvoke('1: Invocation with a model but no tools', agentWithoutTools, 'Hello!')
  await runInvoke(
    '2: Invocation that uses a tool',
    agentWithTools,
    'What is the weather in Toronto? Use the weather tool.'
  )

  const streamingAgentWithTools = new Agent({
    systemPrompt: 'You are a helpful assistant that provides weather information using the get_weather tool.',
    model,
    tools: [weatherTool],
    printer: false,
  })

  // Demonstrate the stream() pattern (for when you need intermediate events)
  console.log('\n=== Streaming pattern (advanced) ===\n')
  await runStreaming('3: Streaming invocation with events', streamingAgentWithTools, 'What is the weather in Seattle?')
}

await main().catch(console.error)
