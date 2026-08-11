/**
 * TypeScript examples for Anthropic model provider documentation.
 * These examples demonstrate common usage patterns for the AnthropicModel.
 */

import Anthropic from '@anthropic-ai/sdk'
import { Agent, tool } from '@strands-agents/sdk'
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

// Server-side tools
async function serverSideTools() {
  // --8<-- [start:server_side_tools]
  const recordFinding = tool({
    name: 'record_finding',
    description: 'Record a finding for later review.',
    inputSchema: z.object({ summary: z.string() }),
    callback: ({ summary }) => `recorded: ${summary}`,
  })

  const model = new AnthropicModel({
    apiKey: '<KEY>',
    modelId: 'claude-sonnet-4-6',
    maxTokens: 1028,
    anthropicTools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 5 }],
  })

  // `recordFinding` still reaches the model: `anthropicTools` is appended to the agent's
  // function tools rather than replacing them.
  const agent = new Agent({ model, tools: [recordFinding] })
  const response = await agent.invoke(
    'Search for what Anthropic announced this week, then record your finding.'
  )
  console.log(response)
  // --8<-- [end:server_side_tools]
}

void structuredOutputExample
void serverSideTools
