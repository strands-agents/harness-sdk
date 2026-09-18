/**
 * Verification script to ensure the built package can be imported without a bundler.
 * This script runs in a pure Node.js ES module environment.
 */

import { Agent, BedrockModel, ModelRouter, tool, Tool } from '@strands-agents/sdk'

import { ModelRouter as ModelRouterFromSubpath } from '@strands-agents/sdk/models/routing'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

import {
  bash as barrelBash,
  fileEditor as barrelFileEditor,
  httpRequest as barrelHttpRequest,
  notebook as barrelNotebook,
} from '@strands-agents/sdk/vended-tools'

import { AgentSkills, ContextOffloader, GoalLoop, InMemoryStorage } from '@strands-agents/sdk/vended-plugins'

import { GoalLoop as GoalLoopFromSubpath } from '@strands-agents/sdk/vended-plugins/goal'

// Verify model subpath exports
import { BedrockModel as BedrockFromSubpath } from '@strands-agents/sdk/models/bedrock'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { LiteLLMModel } from '@strands-agents/sdk/models/litellm'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { GoogleModel } from '@strands-agents/sdk/models/google'

import { z } from 'zod'

console.log('✓ Import from main entry point successful')

// Verify BedrockModel can be instantiated
const model = new BedrockModel({ region: 'us-west-2' })
console.log('✓ BedrockModel instantiation successful')

// Verify basic functionality
const config = model.getConfig()
if (!config) {
  throw new Error('BedrockModel config is invalid')
}
console.log('✓ BedrockModel configuration retrieval successful')

// Define a tool
const example_tool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a specific location.',
  inputSchema: z.object({
    location: z.string().describe('The city and state, e.g., San Francisco, CA'),
  }),
  callback: (input) => {
    console.log(`\n[WeatherTool] Getting weather for ${input.location}...`)

    const fakeWeatherData = {
      temperature: '72°F',
      conditions: 'sunny',
    }

    return `The weather in ${input.location} is ${fakeWeatherData.temperature} and ${fakeWeatherData.conditions}.`
  },
})
console.log('✓ Tool created successful')

// Verify tool can be called
const response = await example_tool.invoke({ location: 'New York' })
if (response !== `The weather in New York is 72°F and sunny.`) {
  throw new Error('Tool returned invalid response')
}

// Verify Agent can be instantiated
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

async function validateScratchpad() {
  let context = { agent: agent }
  notebook.invoke(
    {
      mode: 'create',
      name: 'scratchpad',
      newStr: 'Content',
    },
    context
  )

  const result = await notebook.invoke(
    {
      mode: 'read',
      name: 'scratchpad',
    },
    context
  )

  if (result !== 'Content') {
    throw new Error(`Tool returned invalid response: ${result}`)
  }

  console.log('Notebook created successful')
}

const tools = {
  notebook,
  fileEditor,
  httpRequest,
  bash,
}

for (const tool of Object.values(tools)) {
  if (!(tool instanceof Tool)) {
    throw new Error(`Tool ${tool.name} isn't an instance of a tool`)
  }
}

// Verify model subpath exports resolve correctly
if (BedrockFromSubpath !== BedrockModel) {
  throw new Error('BedrockModel from subpath should match main export')
}
if (ModelRouterFromSubpath !== ModelRouter) {
  throw new Error('ModelRouter from subpath should match main export')
}
console.log('✓ Model subpath exports verified')

if (typeof LiteLLMModel !== 'function') {
  throw new Error('LiteLLMModel subpath export is not constructible')
}
console.log('✓ LiteLLMModel subpath export verified')

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
