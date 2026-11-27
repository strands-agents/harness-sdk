/**
 * Prompt caching on GPT survives a tool loop whose latest user message carries text rebuilt on every model call.
 *
 * Only `cacheReadInputTokens` tells a reading request from one that rewrites its prefix each call, so the tests
 * assert it directly. Node-only because the Mantle fixture authenticates with the ambient AWS credential chain.
 */

import { describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { Agent, tool } from '@strands-agents/sdk'
import type { Model } from '@strands-agents/sdk'
import { ContextInjector } from '$/sdk/vended-plugins/context-injector/index.js'

import { bedrock, mantle } from '../__fixtures__/model-providers.js'

const lookup = tool({
  name: 'lookup_inventory',
  description: 'Look up how many units of an item are in stock.',
  inputSchema: z.object({ item: z.string() }),
  callback: ({ item }) => ({ widgets: '17', gadgets: '4', gizmos: '9' })[item] ?? '0',
})

/**
 * Runs a tool loop of at least three model calls with per-call text injected before each, and returns the cached
 * input tokens each model call after the first read.
 */
async function cacheReadsAfterFirstCall(model: Model): Promise<number[]> {
  let calls = 0
  const agent = new Agent({
    model,
    tools: [lookup],
    printer: false,
    // A nonce per run makes the first call a cold write; the repeat clears every minimum cacheable prefix.
    systemPrompt: `Session ${uuidv7()}. You are an inventory assistant.\n${'Report stock counts exactly as the tool returns them. '.repeat(400)}`,
    plugins: [new ContextInjector({ trigger: 'everyTurn', renderContent: async () => `<call>${++calls}</call>` })],
  })

  const result = await agent.invoke(
    'Look up widgets, then gadgets, then gizmos, one tool call at a time, and say which has the most stock.'
  )

  expect(result.stopReason).toBe('endTurn')
  const modelCalls = agent.messages.filter((message) => message.role === 'assistant')
  expect(modelCalls.length).toBeGreaterThanOrEqual(3)
  return modelCalls.slice(1).map((message) => message.metadata?.usage?.cacheReadInputTokens ?? 0)
}

describe('prompt caching with per-call content in a GPT tool loop', () => {
  it.skipIf(mantle.skip)('reads the cache on a later call through the Responses API on Bedrock Mantle', async () => {
    const model = mantle.createModel({ modelId: 'openai.gpt-6-luna', cacheConfig: { strategy: 'auto' } })

    const reads = await cacheReadsAfterFirstCall(model)

    expect(Math.max(...reads)).toBeGreaterThan(0)
  })

  it.skipIf(bedrock.skip)('reads the cache on a later call through Converse', async () => {
    const model = bedrock.createModel({
      modelId: 'us.openai.gpt-6-luna',
      region: 'us-east-1',
      cacheConfig: { strategy: 'auto' },
    })

    const reads = await cacheReadsAfterFirstCall(model)

    expect(Math.max(...reads)).toBeGreaterThan(0)
  })
})
