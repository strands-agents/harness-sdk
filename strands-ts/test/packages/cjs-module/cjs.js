/**
 * Verification script to ensure the built package can be imported from a
 * pure-CJS Node project via dynamic import(). The SDK itself is ESM-only;
 * CJS consumers interop by using await import().
 */

async function main() {
  const { Agent, BedrockModel, ModelRouter, tool, Tool } = await import('@strands-agents/sdk')
  const { ModelRouter: ModelRouterFromSubpath } = await import('@strands-agents/sdk/models/routing')

  const { notebook } = await import('@strands-agents/sdk/vended-tools/notebook')
  const { fileEditor } = await import('@strands-agents/sdk/vended-tools/file-editor')
  const { httpRequest } = await import('@strands-agents/sdk/vended-tools/http-request')
  const { bash } = await import('@strands-agents/sdk/vended-tools/bash')

  const {
    bash: barrelBash,
    fileEditor: barrelFileEditor,
    httpRequest: barrelHttpRequest,
    notebook: barrelNotebook,
  } = await import('@strands-agents/sdk/vended-tools')

  const { AgentSkills, ContextOffloader, GoalLoop, InMemoryStorage } =
    await import('@strands-agents/sdk/vended-plugins')

  const { GoalLoop: GoalLoopFromSubpath } = await import('@strands-agents/sdk/vended-plugins/goal')

  const { BedrockModel: BedrockFromSubpath } = await import('@strands-agents/sdk/models/bedrock')
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
  const { LiteLLMModel } = await import('@strands-agents/sdk/models/litellm')
  const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic')
  const { GoogleModel } = await import('@strands-agents/sdk/models/google')

  const { z } = await import('zod')

  console.log('✓ Import from main entry point successful')

  const model = new BedrockModel({ region: 'us-west-2' })
  console.log('✓ BedrockModel instantiation successful')

  const config = model.getConfig()
  if (!config) {
    throw new Error('BedrockModel config is invalid')
  }
  console.log('✓ BedrockModel configuration retrieval successful')

  const example_tool = tool({
    name: 'get_weather',
    description: 'Get the current weather for a specific location.',
    inputSchema: z.object({
      location: z.string().describe('The city and state, e.g., San Francisco, CA'),
    }),
    callback: (input) => {
      console.log(`\n[WeatherTool] Getting weather for ${input.location}...`)
      return `The weather in ${input.location} is 72°F and sunny.`
    },
  })
  console.log('✓ Tool created successful')

  const response = await example_tool.invoke({ location: 'New York' })
  if (response !== `The weather in New York is 72°F and sunny.`) {
    throw new Error('Tool returned invalid response')
  }

  const agent = new Agent({
    tools: [example_tool],
  })

  if (agent.tools.length == 0) {
    throw new Error('Tool was not correctly added to the agent')
  }

  // The Node entry (exports.node -> index.node.js) must register the host default
  // sandbox; this getter throws if it didn't.
  void agent.sandbox
  console.log('✓ Node default sandbox registered')

  const tools = { notebook, fileEditor, httpRequest, bash }
  for (const tool of Object.values(tools)) {
    if (!(tool instanceof Tool)) {
      throw new Error(`Tool ${tool.name} isn't an instance of a tool`)
    }
  }

  if (BedrockFromSubpath !== BedrockModel) {
    throw new Error('BedrockModel from subpath should match main export')
  }
  if (ModelRouterFromSubpath !== ModelRouter) {
    throw new Error('ModelRouter from subpath should match main export')
  }
  console.log('✓ Model subpath exports verified')

  // Verify barrel exports match individual subpath exports
  if (
    barrelBash !== bash ||
    barrelFileEditor !== fileEditor ||
    barrelHttpRequest !== httpRequest ||
    barrelNotebook !== notebook
  ) {
    throw new Error('Barrel vended-tools exports do not match individual subpath exports')
  }
  console.log('✓ Barrel vended-tools exports verified')

  // Verify barrel vended-plugins exports are constructible
  if (
    typeof AgentSkills !== 'function' ||
    typeof ContextOffloader !== 'function' ||
    typeof GoalLoop !== 'function' ||
    typeof InMemoryStorage !== 'function'
  ) {
    throw new Error('Barrel vended-plugins exports are not constructible')
  }
  console.log('✓ Barrel vended-plugins exports verified')

  // Verify the goal subpath export matches the barrel export
  if (GoalLoopFromSubpath !== GoalLoop) {
    throw new Error('GoalLoop from subpath should match barrel export')
  }
  console.log('✓ GoalLoop subpath export verified')

  if (typeof LiteLLMModel !== 'function') {
    throw new Error('LiteLLMModel subpath export is not constructible')
  }
  console.log('✓ LiteLLMModel subpath export verified')

  // Reference remaining imports so static analysis doesn't flag them unused.
  void OpenAIModel
  void AnthropicModel
  void GoogleModel
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
