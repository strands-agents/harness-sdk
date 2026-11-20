import { describe, expect, inject, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { ApiError, GoogleGenAI } from '@google/genai'
import modelInfo from '$/sdk/models/model-info.json' with { type: 'json' }

import { anthropic, gemini } from '../__fixtures__/model-providers.js'

/**
 * Table-wide drift check: every direct-API key in shared/model-info.json matches the provider's reported limit.
 * Keys the provider no longer serves skip (not fail), so the skip list doubles as a report of stale rows.
 * Metadata calls only; no model turns. Bedrock-style `vendor.` keys match neither prefix.
 */

const anthropicApiContextWindow = async (modelId: string): Promise<number | null> => {
  const client = new Anthropic({ apiKey: inject('provider-anthropic').apiKey, dangerouslyAllowBrowser: true })
  try {
    return (await client.models.retrieve(modelId)).max_input_tokens
  } catch (error) {
    if (error instanceof Anthropic.NotFoundError) return null
    throw error
  }
}

const geminiApiContextWindow = async (modelId: string): Promise<number | null> => {
  const client = new GoogleGenAI({ apiKey: inject('provider-gemini').apiKey ?? '' })
  try {
    return (await client.models.get({ model: modelId })).inputTokenLimit ?? null
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

const lookups = [
  { prefix: 'claude-', name: 'Anthropic', skip: anthropic.skip, apiContextWindow: anthropicApiContextWindow },
  { prefix: 'gemini-', name: 'Gemini', skip: gemini.skip, apiContextWindow: geminiApiContextWindow },
]

describe.each(lookups)('$name context-window table', ({ prefix, name, skip, apiContextWindow }) => {
  const rows = Object.entries(modelInfo.models)
    .filter(([modelId]) => modelId.startsWith(prefix))
    .map(([modelId, info]) => [modelId, info.limits?.contextWindow] as const)

  describe.each(rows)('%s', (modelId, tableWindow) => {
    it.skipIf(skip)('matches the provider API', async (ctx) => {
      const apiWindow = await apiContextWindow(modelId)
      if (apiWindow === null) return ctx.skip(`${modelId}: not served by ${name} API: retired?`)

      expect(
        tableWindow,
        `${modelId}: table says ${tableWindow}, provider API reports ${apiWindow}; update shared/model-info.json`
      ).toBe(apiWindow)
    })
  })
})
