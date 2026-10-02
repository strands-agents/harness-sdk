/**
 * TypeScript examples for Vercel AI SDK model provider documentation.
 */
// @ts-nocheck

import { Agent } from '@strands-agents/sdk'
import { VercelModel } from '@strands-agents/sdk/models/vercel'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { openai } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { ollama } from 'ai-sdk-ollama'
import { z } from 'zod'

// Basic usage with OpenAI
async function basicUsageOpenAI() {
  // --8<-- [start:basic_usage_openai]
  import { Agent } from '@strands-agents/sdk'
  import { VercelModel } from '@strands-agents/sdk/models/vercel'
  import { openai } from '@ai-sdk/openai'

  const agent = new Agent({
    model: new VercelModel({ provider: openai('gpt-4o') }),
  })

  const result = await agent.invoke('Hello!')
  console.log(result)
  // --8<-- [end:basic_usage_openai]
}

// Basic usage with Bedrock
async function basicUsageBedrock() {
  // --8<-- [start:basic_usage_bedrock]
  import { Agent } from '@strands-agents/sdk'
  import { VercelModel } from '@strands-agents/sdk/models/vercel'
  import { bedrock } from '@ai-sdk/amazon-bedrock'

  const agent = new Agent({
    model: new VercelModel({
      provider: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    }),
  })

  const result = await agent.invoke('Hello!')
  console.log(result)
  // --8<-- [end:basic_usage_bedrock]
}

// Basic usage with Anthropic
async function basicUsageAnthropic() {
  // --8<-- [start:basic_usage_anthropic]
  import { Agent } from '@strands-agents/sdk'
  import { VercelModel } from '@strands-agents/sdk/models/vercel'
  import { anthropic } from '@ai-sdk/anthropic'

  const agent = new Agent({
    model: new VercelModel({ provider: anthropic('claude-sonnet-4-20250514') }),
  })

  const result = await agent.invoke('Hello!')
  console.log(result)
  // --8<-- [end:basic_usage_anthropic]
}

// Basic usage with Google
async function basicUsageGoogle() {
  // --8<-- [start:basic_usage_google]
  import { Agent } from '@strands-agents/sdk'
  import { VercelModel } from '@strands-agents/sdk/models/vercel'
  import { google } from '@ai-sdk/google'

  const agent = new Agent({
    model: new VercelModel({ provider: google('gemini-2.5-flash') }),
  })

  const result = await agent.invoke('Hello!')
  console.log(result)
  // --8<-- [end:basic_usage_google]
}

// Basic usage with Ollama
async function basicUsageOllama() {
  // --8<-- [start:basic_usage_ollama]
  import { Agent } from '@strands-agents/sdk'
  import { VercelModel } from '@strands-agents/sdk/models/vercel'
  import { ollama } from 'ai-sdk-ollama'

  const agent = new Agent({
    model: new VercelModel({ provider: ollama('llama3.1') }),
  })

  const result = await agent.invoke('Hello!')
  console.log(result)
  // --8<-- [end:basic_usage_ollama]
}

// Configuration example
async function configExample() {
  // --8<-- [start:config_example]
  const model = new VercelModel({
    provider: openai('gpt-4o'),
    maxTokens: 1000,
    temperature: 0.7,
    topP: 0.9,
  })

  const agent = new Agent({ model })
  const result = await agent.invoke('Write a short poem')
  console.log(result)
  // --8<-- [end:config_example]
}

// Streaming example
async function streamingExample() {
  // --8<-- [start:streaming]
  const agent = new Agent({
    model: new VercelModel({ provider: openai('gpt-4o') }),
  })

  for await (const event of agent.stream('Tell me a story')) {
    if (
      event.type === 'modelContentBlockDeltaEvent' &&
      event.delta.type === 'textDelta'
    ) {
      process.stdout.write(event.delta.text)
    }
  }
  // --8<-- [end:streaming]
}

// Structured output
async function structuredOutputExample() {
  // --8<-- [start:structured_output]
  const MovieReview = z.object({
    title: z.string().describe('Movie title'),
    rating: z.number().min(1).max(10).describe('Rating from 1-10'),
    genre: z.string().describe('Primary genre'),
    sentiment: z.enum(['positive', 'negative', 'neutral']).describe('Overall sentiment'),
    summary: z.string().describe('Brief summary of the review'),
  })

  const agent = new Agent({
    model: new VercelModel({ provider: openai('gpt-4o') }),
    structuredOutputSchema: MovieReview,
  })

  const result = await agent.invoke(
    `Just watched "The Matrix" - what an incredible sci-fi masterpiece!
     The groundbreaking visual effects and philosophical themes make this
     a must-watch. Keanu Reeves delivers a solid performance. 9/10!`
  )

  const review = result.structuredOutput as z.infer<typeof MovieReview>
  console.log(`Movie: ${review.title}`)
  console.log(`Rating: ${review.rating}/10`)
  console.log(`Sentiment: ${review.sentiment}`)
  // --8<-- [end:structured_output]
}

void structuredOutputExample
