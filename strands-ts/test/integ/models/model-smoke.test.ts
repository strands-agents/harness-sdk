import { describe, expect, it } from 'vitest'
import { Agent, type Model } from '@strands-agents/sdk'

import { anthropic, bedrock, gemini, mantle, openai } from '../__fixtures__/model-providers.js'
import { echoTool, isInBrowser } from '../__fixtures__/test-helpers.js'

/**
 * Per-model smoke table: the context window resolves from the model table and a tool-using turn completes.
 * One row per model; each row carries its provider's skip flag, so missing credentials skip only that
 * provider's rows. Mantle authenticates with the ambient AWS credential chain, which only exists in node.
 */

interface SmokeProvider {
  skip: boolean
  nodeOnly?: boolean
  create: (modelId: string) => Model
}

const smoke = {
  anthropic: { skip: anthropic.skip, create: (modelId) => anthropic.createModel({ modelId }) },
  gemini: { skip: gemini.skip, create: (modelId) => gemini.createModel({ modelId }) },
  // The TS Bedrock fixture sets no region, and the 2026-10 catalog models are served from us-east-1.
  bedrock: { skip: bedrock.skip, create: (modelId) => bedrock.createModel({ modelId, region: 'us-east-1' }) },
  openai: { skip: openai.skip, create: (modelId) => openai.createModel({ modelId }) },
  mantle: { skip: mantle.skip, nodeOnly: true, create: (modelId) => mantle.createModel({ modelId }) },
} satisfies Record<string, SmokeProvider>

const rows: [SmokeProvider, string, number][] = [
  [smoke.anthropic, 'claude-opus-5-5', 1_000_000],
  [smoke.anthropic, 'claude-sonnet-5-5', 1_000_000],
  [smoke.anthropic, 'claude-haiku-5-5', 1_000_000],
  [smoke.gemini, 'gemini-4-argon', 1_048_576],
  [smoke.gemini, 'gemini-3.8-flash', 1_048_576],
  [smoke.bedrock, 'us.xai.grok-4.7', 524_288],
  [smoke.bedrock, 'mistral.mistral-large-3-675b-instruct', 256_000],
  [smoke.openai, 'chat-latest', 272_000],
  [smoke.mantle, 'google.gemma-4-31b', 256_000],
  [smoke.mantle, 'openai.gpt-oss-120b', 128_000],
]

describe.each(rows)('Model smoke: $1', (provider, modelId, expectedWindow) => {
  const skip = provider.skip || (provider.nodeOnly && isInBrowser())

  it.skipIf(skip)('resolves the context window from the model table', () => {
    expect(provider.create(modelId).getConfig().contextWindowLimit).toBe(expectedWindow)
  })

  it.skipIf(skip)('completes a tool-using turn', async () => {
    const agent = new Agent({ model: provider.create(modelId), tools: [echoTool], printer: false })

    const result = await agent.invoke("Use the echo tool to echo the value 'pineapple'.")

    expect(result.stopReason).toBe('endTurn')
    const toolUse = agent.messages.find((msg) => msg.content.some((block) => block.type === 'toolUseBlock'))
    expect(toolUse).toBeDefined()
  })
})
