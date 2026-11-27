import { Agent, tool } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { GoogleModel } from '@strands-agents/sdk/models/google'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import z from 'zod'

// ---------------------------------------------------------------------------
// Run your first agent (no tools). One snippet per provider.
// ---------------------------------------------------------------------------

async function runBedrock() {
  // --8<-- [start:run-bedrock]
  // Bedrock is the default, so no model object is needed.
  const agent = new Agent()
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)
  // --8<-- [end:run-bedrock]
}

async function runAnthropic() {
  // --8<-- [start:run-anthropic]
  // Reads ANTHROPIC_API_KEY from the environment.
  const model = new AnthropicModel({ modelId: 'claude-sonnet-5' })
  const agent = new Agent({ model })
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)
  // --8<-- [end:run-anthropic]
}

async function runOpenAI() {
  // --8<-- [start:run-openai]
  // Reads OPENAI_API_KEY from the environment.
  const model = new OpenAIModel({ modelId: 'gpt-5.4' })
  const agent = new Agent({ model })
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)
  // --8<-- [end:run-openai]
}

async function runGoogle() {
  // --8<-- [start:run-google]
  // Reads GEMINI_API_KEY from the environment.
  const model = new GoogleModel({ modelId: 'gemini-2.5-flash' })
  const agent = new Agent({ model })
  const result = await agent.invoke('What is an agent harness, in one sentence?')
  console.log(result.lastMessage)
  // --8<-- [end:run-google]
}

// ---------------------------------------------------------------------------
// Add your first tool. The tool is shared; the agent creation is per provider.
// ---------------------------------------------------------------------------

// --8<-- [start:custom-tool]
// Define a custom tool as a TypeScript function
const letterCounter = tool({
  name: 'letter_counter',
  description:
    'Count occurrences of a specific letter in a word. Performs case-insensitive matching.',
  // Zod schema for letter counter input validation
  inputSchema: z
    .object({
      word: z.string().describe('The input word to search in'),
      letter: z.string().describe('The specific letter to count'),
    })
    .refine((data) => data.letter.length === 1, {
      message: "The 'letter' parameter must be a single character",
    }),
  callback: (input) => {
    const { word, letter } = input

    // Convert both to lowercase for case-insensitive comparison
    const lowerWord = word.toLowerCase()
    const lowerLetter = letter.toLowerCase()

    // Count occurrences
    let count = 0
    for (const char of lowerWord) {
      if (char === lowerLetter) {
        count++
      }
    }

    return `The letter '${letter}' appears ${count} time(s) in '${word}'`
  },
})
// --8<-- [end:custom-tool]

async function toolBedrock() {
  // --8<-- [start:tool-bedrock]
  const agent = new Agent({ tools: [letterCounter, fileEditor] })
  const result = await agent.invoke(
    `How many letter R's are in the word "strawberry"? Write the answer to answer.txt.`
  )
  console.log(result.lastMessage)
  // --8<-- [end:tool-bedrock]
}

async function toolAnthropic() {
  // --8<-- [start:tool-anthropic]
  const model = new AnthropicModel({ modelId: 'claude-sonnet-5' })
  const agent = new Agent({ model, tools: [letterCounter, fileEditor] })
  const result = await agent.invoke(
    `How many letter R's are in the word "strawberry"? Write the answer to answer.txt.`
  )
  console.log(result.lastMessage)
  // --8<-- [end:tool-anthropic]
}

async function toolOpenAI() {
  // --8<-- [start:tool-openai]
  const model = new OpenAIModel({ modelId: 'gpt-5.4' })
  const agent = new Agent({ model, tools: [letterCounter, fileEditor] })
  const result = await agent.invoke(
    `How many letter R's are in the word "strawberry"? Write the answer to answer.txt.`
  )
  console.log(result.lastMessage)
  // --8<-- [end:tool-openai]
}

async function toolGoogle() {
  // --8<-- [start:tool-google]
  const model = new GoogleModel({ modelId: 'gemini-2.5-flash' })
  const agent = new Agent({ model, tools: [letterCounter, fileEditor] })
  const result = await agent.invoke(
    `How many letter R's are in the word "strawberry"? Write the answer to answer.txt.`
  )
  console.log(result.lastMessage)
  // --8<-- [end:tool-google]
}

// ---------------------------------------------------------------------------
// Snippets referenced elsewhere on the quickstart page.
// ---------------------------------------------------------------------------

// --8<-- [start:disable-console]
const quietAgent = new Agent({
  tools: [letterCounter],
  printer: false, // Disable console output
})
// --8<-- [end:disable-console]

// --8<-- [start:model-config]
// Check the model configuration
const myAgent = new Agent()
console.log(myAgent['model'].getConfig().modelId)
// Output: { modelId: 'global.anthropic.claude-sonnet-5' }
// --8<-- [end:model-config]

// --8<-- [start:model-string]
// Create an agent with a specific model by passing the model ID string
const specificAgent = new Agent({
  model: 'global.anthropic.claude-opus-4-6-v1',
})
// --8<-- [end:model-string]

// --8<-- [start:bedrock-model]
import { BedrockModel } from '@strands-agents/sdk'

// Create a BedrockModel with custom configuration
const bedrockModel = new BedrockModel({
  modelId: 'global.anthropic.claude-opus-4-6-v1',
  region: 'us-west-2',
  temperature: 0.3,
})

const bedrockAgent = new Agent({ model: bedrockModel })
// --8<-- [end:bedrock-model]

// --8<-- [start:streaming-async]
// Async function that iterates over streamed agent events
async function processStreamingResponse() {
  const agent = new Agent({ tools: [letterCounter] })
  const prompt = 'What is 25 * 48 and explain the calculation'

  // Stream the response as it's generated from the agent:
  for await (const event of agent.stream(prompt)) {
    console.log('Event:', event.type)
  }
}

// Run the streaming example
await processStreamingResponse()
// --8<-- [end:streaming-async]

async function accessMessages() {
  // --8<-- [start:agentMessages]
  // Access the agent's message array
  const agent = new Agent({ tools: [letterCounter] })
  const result = await agent.invoke('What is the square root of 144?')
  console.log(agent.messages)
  // --8<-- [end:agentMessages]
}
