import { describe, expect, it } from 'vitest'
import { Agent, CachePointBlock, Message, ModelThrottledError, TextBlock } from '@strands-agents/sdk'
import type { Model, ModelStreamEvent } from '@strands-agents/sdk'

import { collectIterator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { anthropic, bedrock, gemini, mantle, openai } from '../__fixtures__/model-providers.js'
import { echoTool, isInBrowser } from '../__fixtures__/test-helpers.js'

/**
 * Per-model conformance: every listed model does what the model table says about it.
 * One row per model; each row carries its provider's skip flag, so missing credentials skip only that
 * provider's rows. A row's declared capabilities are the ones the built model reports, since a provider
 * turns off what it cannot use.
 */

interface RowProvider {
  skip: boolean
  nodeOnly?: boolean
  create: (modelId: string) => Model
}

const providers = {
  anthropic: { skip: anthropic.skip, create: (modelId) => anthropic.createModel({ modelId }) },
  gemini: { skip: gemini.skip, create: (modelId) => gemini.createModel({ modelId }) },
  // The Bedrock fixture sets no region, and the listed ids are all served from us-east-1.
  bedrock: { skip: bedrock.skip, create: (modelId) => bedrock.createModel({ modelId, region: 'us-east-1' }) },
  openai: { skip: openai.skip, create: (modelId) => openai.createModel({ modelId }) },
  // Mantle authenticates with the ambient AWS credential chain, which only exists in node.
  mantle: { skip: mantle.skip, nodeOnly: true, create: (modelId) => mantle.createModel({ modelId }) },
} satisfies Record<string, RowProvider>

const rows: [keyof typeof providers, string, number][] = [
  ['anthropic', 'claude-opus-5-5', 1_000_000],
  ['anthropic', 'claude-sonnet-5-5', 1_000_000],
  ['anthropic', 'claude-haiku-5-5', 1_000_000],
  ['gemini', 'gemini-4-hydrogen', 1_048_576],
  ['gemini', 'gemini-4-argon', 1_048_576],
  ['gemini', 'gemini-3.8-flash', 1_048_576],
  ['bedrock', 'us.xai.grok-4.7', 524_288],
  ['bedrock', 'mistral.mistral-large-3-675b-instruct', 256_000],
  ['bedrock', 'global.anthropic.claude-opus-5', 1_000_000],
  ['bedrock', 'global.anthropic.claude-opus-5-5', 1_000_000],
  ['bedrock', 'global.anthropic.claude-sonnet-5', 1_000_000],
  ['bedrock', 'global.anthropic.claude-sonnet-5-5', 1_000_000],
  ['bedrock', 'global.anthropic.claude-haiku-5-5', 1_000_000],
  ['bedrock', 'global.anthropic.claude-haiku-4-5-20251001-v1:0', 200_000],
  ['bedrock', 'us.amazon.nova-2-lite-v1:0', 1_000_000],
  ['bedrock', 'us.amazon.nova-pro-v1:0', 300_000],
  ['openai', 'chat-latest', 272_000],
  ['mantle', 'google.gemma-4-31b', 256_000],
  ['mantle', 'openai.gpt-oss-120b', 128_000],
]

// The table says these models cannot be forced to call a tool; the provider accepts a forced call.
const FORCED_TOOL_CHOICE_DISAGREES = new Set(['claude-haiku-5-5', 'global.anthropic.claude-haiku-5-5'])

// Provider error text meaning the model cannot be forced to call a tool.
const FORCED_TOOL_CHOICE_REFUSALS = [
  'tool_choice: type "tool" and "any" are not supported',
  "doesn't support the toolConfig.toolChoice",
]

// Longer than any listed model's cache minimum. The lines differ because repeated lines trip a content filter.
const CACHED_TEXT = Array.from(
  { length: 600 },
  (_, index) => `Record ${index}: station ${index * 37} logged ${index * 101} units.`
).join('\n')

const startsToolUse = (event: ModelStreamEvent): boolean =>
  event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart'

for (const [name, modelId, expectedWindow] of rows) {
  const provider: RowProvider = providers[name]
  const skipRow = provider.skip || (provider.nodeOnly === true && isInBrowser())

  describe(`Model conformance: ${name}-${modelId}`, () => {
    it.skipIf(skipRow)('resolves the context window from the model table', () => {
      expect(provider.create(modelId).getConfig().contextWindowLimit).toBe(expectedWindow)
    })

    it.skipIf(skipRow)('completes a tool-using turn', async () => {
      const agent = new Agent({ model: provider.create(modelId), tools: [echoTool], printer: false })

      const result = await agent.invoke("Use the echo tool to echo the value 'pineapple'.")

      expect(result.stopReason).toBe('endTurn')
      const toolUse = agent.messages.find((msg) => msg.content.some((block) => block.type === 'toolUseBlock'))
      expect(toolUse).toBeDefined()
    })

    it.skipIf(skipRow)(
      'accepts or refuses a forced tool choice as declared',
      { fails: FORCED_TOOL_CHOICE_DISAGREES.has(modelId) },
      async ({ skip }) => {
        const model = provider.create(modelId)
        const declared = model.modelInfo.capabilities?.forcedToolChoice
        if (declared === undefined) skip('the model declares nothing about forced tool choice')
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello there!')] })]

        // A model that accepts a forced call can still end a turn without one, so only a tool use or a refusal is final.
        let outcome = 'no tool use'
        try {
          for (let attempt = 0; attempt < 3 && outcome !== 'accepted'; attempt++) {
            const events = await collectIterator(
              model.stream(messages, { toolSpecs: [echoTool.toolSpec], toolChoice: { any: {} } })
            )
            if (events.some(startsToolUse)) outcome = 'accepted'
          }
        } catch (error) {
          if (error instanceof ModelThrottledError) skip(`not validated: ${String(error)}`)
          if (!FORCED_TOOL_CHOICE_REFUSALS.some((refusal) => String(error).includes(refusal))) throw error
          outcome = 'refused'
        }

        expect(outcome).toBe(declared ? 'accepted' : 'refused')
      }
    )

    it.skipIf(skipRow)('reads a cache point on a repeated request', async ({ skip }) => {
      const model = provider.create(modelId)
      if (model.modelInfo.capabilities?.promptCaching !== 'cachePoints') skip('the model does not declare cache points')
      const request = async (): Promise<number> => {
        const events = await collectIterator(
          model.stream([new Message({ role: 'user', content: [new TextBlock('Reply with OK.')] })], {
            systemPrompt: [new TextBlock(CACHED_TEXT), new CachePointBlock({ cacheType: 'default' })],
          })
        )
        return events.find((event) => event.type === 'modelMetadataEvent')?.usage?.cacheReadInputTokens ?? 0
      }

      await request()

      // On a Bedrock inference profile a repeat can write again before one reads, so one miss is not a failure.
      let cacheRead = 0
      for (let attempt = 0; attempt < 3 && cacheRead === 0; attempt++) cacheRead = await request()

      expect(cacheRead).toBeGreaterThan(0)
    })
  })
}
