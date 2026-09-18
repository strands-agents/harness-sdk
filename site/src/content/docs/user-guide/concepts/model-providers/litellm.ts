import { Agent, CachePointBlock, TextBlock } from '@strands-agents/sdk'
import { LiteLLMModel } from '@strands-agents/sdk/models/litellm'
import { z } from 'zod'

async function basicUsage() {
  // --8<-- [start:basic_usage]
  const baseURL = process.env.LITELLM_BASE_URL
  if (!baseURL) throw new Error('LITELLM_BASE_URL is required')
  const apiKey = process.env.LITELLM_API_KEY
  if (!apiKey) throw new Error('LITELLM_API_KEY is required')

  const model = new LiteLLMModel({
    modelId: 'anthropic/claude-sonnet-4-20250514',
    baseURL,
    apiKey,
    temperature: 0.7,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2?')
  console.log(response)
  // Typical output: an AgentResult containing the model response.
  // --8<-- [end:basic_usage]
}

async function proxyUsage() {
  // --8<-- [start:proxy_usage]
  const baseURL = process.env.LITELLM_BASE_URL
  if (!baseURL) throw new Error('LITELLM_BASE_URL is required')
  const apiKey = process.env.LITELLM_API_KEY
  if (!apiKey) throw new Error('LITELLM_API_KEY is required')

  const model = new LiteLLMModel({
    modelId: 'amazon.nova-lite-v1:0',
    baseURL,
    apiKey,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Tell me a story.')
  console.log(response)
  // Typical output: an AgentResult containing the model response.
  // --8<-- [end:proxy_usage]
}

async function cachingUsage() {
  // --8<-- [start:caching_usage]
  const baseURL = process.env.LITELLM_BASE_URL
  if (!baseURL) throw new Error('LITELLM_BASE_URL is required')
  const apiKey = process.env.LITELLM_API_KEY
  if (!apiKey) throw new Error('LITELLM_API_KEY is required')

  const model = new LiteLLMModel({
    modelId: 'anthropic/claude-sonnet-4-20250514',
    baseURL,
    apiKey,
  })

  const systemPrompt = [
    new TextBlock('Use concise answers. This context is reused across requests.'),
    new CachePointBlock({ cacheType: 'default', ttl: '1h' }),
  ]
  const agent = new Agent({ model, systemPrompt })

  const firstResponse = await agent.invoke('Tell me about Python.')
  const secondResponse = await agent.invoke('Tell me about JavaScript.')
  console.log(firstResponse.metrics?.accumulatedUsage)
  console.log(secondResponse.metrics?.accumulatedUsage)
  // Typical output: usage fields reported by the upstream provider.
  // --8<-- [end:caching_usage]
}

async function structuredOutputUsage() {
  // --8<-- [start:structured_output]
  const baseURL = process.env.LITELLM_BASE_URL
  if (!baseURL) throw new Error('LITELLM_BASE_URL is required')
  const apiKey = process.env.LITELLM_API_KEY
  if (!apiKey) throw new Error('LITELLM_API_KEY is required')

  const BookAnalysis = z.object({
    title: z.string(),
    author: z.string(),
    genre: z.string(),
    summary: z.string(),
    rating: z.number().min(1).max(10),
  })

  const model = new LiteLLMModel({
    modelId: 'anthropic/claude-sonnet-4-20250514',
    baseURL,
    apiKey,
  })
  const agent = new Agent({ model, structuredOutputSchema: BookAnalysis })

  const result = await agent.invoke(
    "Analyze The Hitchhiker's Guide to the Galaxy by Douglas Adams. " +
      'Return its title, author, genre, summary, and rating.'
  )
  const analysis = BookAnalysis.parse(result.structuredOutput)
  console.log(analysis.title, analysis.rating)
  // --8<-- [end:structured_output]
}

void basicUsage
void proxyUsage
void cachingUsage
void structuredOutputUsage
