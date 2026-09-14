/**
 * TypeScript examples for Anthropic model provider documentation.
 * These examples demonstrate common usage patterns for the AnthropicModel.
 */

import Anthropic from '@anthropic-ai/sdk'
import { Agent } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { z } from 'zod'

// Basic usage
async function basicUsage() {
  // --8<-- [start:basic_usage]
  const model = new AnthropicModel({
    apiKey: process.env.ANTHROPIC_API_KEY || '<KEY>',
    modelId: 'claude-sonnet-4-6',
    maxTokens: 1028,
    params: {
      temperature: 0.7,
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2')
  console.log(response)
  // --8<-- [end:basic_usage]
}

// Custom client
async function customClient() {
  // --8<-- [start:custom_client]
  const client = new Anthropic({ apiKey: '<KEY>' })

  const model = new AnthropicModel({
    client,
    modelId: 'claude-sonnet-4-6',
    maxTokens: 1028,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2')
  console.log(response)
  // --8<-- [end:custom_client]
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

  const model = new AnthropicModel({
    apiKey: '<KEY>',
    modelId: 'claude-sonnet-4-6',
    maxTokens: 1028,
  })

  const agent = new Agent({ model, structuredOutputSchema: MovieReview })

  const result = await agent.invoke(
    `Just watched "The Matrix" - what an incredible sci-fi masterpiece!
     The groundbreaking visual effects and philosophical themes make this
     a must-watch. Keanu Reeves delivers a solid performance. 9/10!`
  )

  const review = result.structuredOutput as z.infer<typeof MovieReview>
  console.log(`Movie: ${review.title}`)
  console.log(`Rating: ${review.rating}/10`)
  console.log(`Genre: ${review.genre}`)
  console.log(`Sentiment: ${review.sentiment}`)
  // --8<-- [end:structured_output]
}

void structuredOutputExample

async function promptCaching() {
  // --8<-- [start:prompt_caching]
  const model = new AnthropicModel({
    modelId: 'claude-sonnet-4-6',
    maxTokens: 1028,
    cacheConfig: { ttl: '1h' },
  })

  const agent = new Agent({ model })
  const result = await agent.invoke('Summarize the attached report.')
  console.log(result.metrics?.accumulatedUsage)

  // Typical output:
  // { inputTokens: 12, ..., cacheReadInputTokens: 2505 }
  // --8<-- [end:prompt_caching]
}

// Amazon Bedrock (Mantle)
async function bedrockMantle() {
  // --8<-- [start:bedrock_mantle]
  const model = new AnthropicModel({
    modelId: 'anthropic.claude-sonnet-5',
    maxTokens: 1028,
    bedrockMantleConfig: { region: 'us-east-1' },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2?')
  console.log(response)
  // --8<-- [end:bedrock_mantle]
}
