/**
 * TypeScript examples for Amazon Bedrock prompt caching documentation.
 * These examples demonstrate caching system prompts, tools, and messages.
 */
// @ts-nocheck
// Imports are in amazon-bedrock-prompt-caching_imports.ts

import {
  Agent,
  BedrockModel,
  CachePointBlock,
  DocumentBlock,
  Message,
} from '@strands-agents/sdk'

// System prompt caching
async function systemPromptCachingFull() {
  // --8<-- [start:system_prompt_caching_full]
  const systemContent = [
    'You are a helpful assistant that provides concise answers. ' +
      'This is a long system prompt with detailed instructions...' +
      '...'.repeat(1600), // needs to be at least 1,024 tokens
    new CachePointBlock({ cacheType: 'default' }),
  ]

  const agent = new Agent({ systemPrompt: systemContent })

  // First request will cache the system prompt
  let cacheWriteTokens = 0
  let cacheReadTokens = 0

  for await (const event of agent.stream('Tell me about Python')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)

  // Second request will reuse the cached system prompt
  for await (const event of agent.stream('Tell me about JavaScript')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)
  // --8<-- [end:system_prompt_caching_full]
}

// Tool caching
async function toolCachingFull() {
  // --8<-- [start:tool_caching_full]
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    cacheConfig: { strategy: 'auto' },
  })

  const agent = new Agent({
    model: bedrockModel,
    // Add your tools here
  })

  // First request will cache the tools
  let cacheWriteTokens = 0
  let cacheReadTokens = 0

  for await (const event of agent.stream('What time is it?')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)

  // Second request will reuse the cached tools
  for await (const event of agent.stream('What is the square root of 1764?')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)
  // --8<-- [end:tool_caching_full]
}

// Automatic cache strategy for messages
async function automaticCacheStrategy() {
  // --8<-- [start:automatic_cache_strategy]
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    cacheConfig: { strategy: 'auto' },
  })

  const agent = new Agent({ model: bedrockModel })

  // Agent call - cache write and read occur as context accumulates
  let cacheWriteTokens = 0
  let cacheReadTokens = 0

  for await (const event of agent.stream(
    'Search for Python async patterns, then compare with error handling'
  )) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)

  // Follow-up reuses cached context from previous conversation
  for await (const event of agent.stream('Summarize the key differences')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)
  // --8<-- [end:automatic_cache_strategy]
}

// Messages caching
async function messagesCachingFull() {
  // --8<-- [start:messages_caching_full]
  const documentBytes = Buffer.from('This is a sample document!')

  const userMessage = new Message({
    role: 'user',
    content: [
      new DocumentBlock({
        format: 'txt',
        name: 'example',
        source: { bytes: documentBytes },
      }),
      'Use this document in your response.',
      new CachePointBlock({ cacheType: 'default' }),
    ],
  })

  const assistantMessage = new Message({
    role: 'assistant',
    content: ['I will reference that document in my following responses.'],
  })

  const agent = new Agent({
    messages: [userMessage, assistantMessage],
  })

  // First request will cache the message
  let cacheWriteTokens = 0
  let cacheReadTokens = 0

  for await (const event of agent.stream('What is in that document?')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)

  // Second request will reuse the cached message
  for await (const event of agent.stream('How long is the document?')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      cacheWriteTokens = event.usage.cacheWriteInputTokens || 0
      cacheReadTokens = event.usage.cacheReadInputTokens || 0
    }
  }
  console.log(`Cache write tokens: ${cacheWriteTokens}`)
  console.log(`Cache read tokens: ${cacheReadTokens}`)
  // --8<-- [end:messages_caching_full]
}

// Cache metrics
async function cacheMetrics() {
  // --8<-- [start:cache_metrics]
  const agent = new Agent()

  for await (const event of agent.stream('Hello!')) {
    if (event.type === 'modelMetadataEvent' && event.usage) {
      console.log(`Cache write tokens: ${event.usage.cacheWriteInputTokens || 0}`)
      console.log(`Cache read tokens: ${event.usage.cacheReadInputTokens || 0}`)
    }
  }
  // --8<-- [end:cache_metrics]
}
