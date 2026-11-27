/**
 * Switching models mid-conversation keeps or drops earlier reasoning as each model needs.
 *
 * Signed reasoning reaches only models of the vendor that signed it; any other model gets its text and the
 * conversation continues. Each test runs a tool turn on one model, switches `agent.model`, and runs another tool turn.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Agent, Message, ReasoningBlock, TextBlock, ToolResultBlock, ToolUseBlock, tool } from '@strands-agents/sdk'
import type { Model } from '@strands-agents/sdk'
import { anthropic, bedrock, gemini, openaiResponses } from '../__fixtures__/model-providers.js'

const thinking = { thinking: { type: 'enabled', budget_tokens: 1024 } }

const add = tool({
  name: 'add',
  description: 'Add two integers.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  callback: ({ a, b }) => a + b,
})

const bedrockClaude = (modelId = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'): Model =>
  bedrock.createModel({ modelId, maxTokens: 4096, additionalRequestFields: thinking })
const anthropicClaude = (): Model =>
  anthropic.createModel({ modelId: 'claude-haiku-4-5', maxTokens: 4096, params: thinking })
const googleGemini = (): Model =>
  gemini.createModel({ modelId: 'gemini-2.5-flash', params: { thinkingConfig: { includeThoughts: true } } })
const responses = (): Model => openaiResponses.createModel({ modelId: 'gpt-5-mini' })

const secondTurn = 'Now use the add tool to add 100 to that result, then reply with the number.'

async function firstTurn(model: Model): Promise<Agent> {
  const agent = new Agent({ model, tools: [add], printer: false })
  await agent.invoke('Think first, then use the add tool to compute 17 + 25.')
  return agent
}

/** Runs `prompt` on `model` and returns the reasoning blocks the model received in its first call. */
async function reasoningSent(model: Model, agent: Agent, prompt: string): Promise<ReasoningBlock[]> {
  agent.model = model
  const spy = vi.spyOn(model, 'stream')
  const result = await agent.invoke(prompt)
  expect(String(result)).toContain('142')
  const sent = spy.mock.calls[0]![0] as Message[]
  return sent.flatMap((message) =>
    message.content.filter((block): block is ReasoningBlock => block.type === 'reasoningBlock')
  )
}

const signed = (blocks: ReasoningBlock[]): boolean => blocks.some((block) => Boolean(block.signature))

describe.skipIf(bedrock.skip)('switching models with reasoning in the conversation', () => {
  it.each([
    {
      name: 'Haiku to Sonnet on Bedrock',
      skip: false,
      first: bedrockClaude,
      second: () => bedrockClaude('us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    },
    { name: 'Bedrock to the Anthropic API', skip: anthropic.skip, first: bedrockClaude, second: anthropicClaude },
    { name: 'the Anthropic API to Bedrock', skip: anthropic.skip, first: anthropicClaude, second: bedrockClaude },
  ])('carries Claude reasoning from $name', async ({ skip, first, second }) => {
    if (skip) return
    const agent = await firstTurn(first())
    const tagged = agent.messages[1]!.content.some(
      (block) => block.type === 'reasoningBlock' && block.providerData?.provider === 'anthropic'
    )
    expect(tagged).toBe(true)
    expect(signed(await reasoningSent(second(), agent, secondTurn))).toBe(true)
  })

  it.each([
    { name: 'Bedrock Claude to Gemini', skip: gemini.skip, first: bedrockClaude, second: googleGemini },
    { name: 'Gemini to Bedrock Claude', skip: gemini.skip, first: googleGemini, second: bedrockClaude },
    { name: 'Bedrock Claude to OpenAI Responses', skip: openaiResponses.skip, first: bedrockClaude, second: responses },
    { name: 'OpenAI Responses to Bedrock Claude', skip: openaiResponses.skip, first: responses, second: bedrockClaude },
  ])('keeps going from $name without sending a foreign signature', async ({ skip, first, second }) => {
    if (skip) return
    const agent = await firstTurn(first())
    expect(signed(await reasoningSent(second(), agent, secondTurn))).toBe(false)
  })

  it('never sends reasoning another vendor signed to Claude', async () => {
    // Before tagging, a Gemini signature replayed to Claude failed with `Invalid signature in thinking block`.
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('Use the add tool to compute 17 + 25.')] }),
      new Message({
        role: 'assistant',
        content: [
          new ReasoningBlock({
            text: 'I will add the numbers.',
            signature: 'c2lnbmVkLWJ5LWdlbWluaQ==',
            providerData: { provider: 'google', modelId: 'gemini', data: {} },
          }),
          new ToolUseBlock({ name: 'add', toolUseId: 't1', input: { a: 17, b: 25 } }),
        ],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('42')] })],
      }),
    ]
    const model = bedrockClaude()
    const agent = new Agent({ model, tools: [add], messages, printer: false })
    expect(await reasoningSent(model, agent, secondTurn)).toEqual([
      new ReasoningBlock({ text: 'I will add the numbers.' }),
    ])
  })

  it.skipIf(openaiResponses.skip)('keeps OpenAI Responses reasoning through a round trip via Claude', async () => {
    const agent = await firstTurn(responses())
    await reasoningSent(bedrockClaude(), agent, secondTurn)
    const back = responses()
    agent.model = back
    const spy = vi.spyOn(back, 'stream')
    expect(
      String(await agent.invoke('Use the add tool to add 1 to the last result, then reply with the number.'))
    ).toContain('143')
    const sent = spy.mock.calls[0]![0] as Message[]
    const replayed = sent.some((message) =>
      message.content.some(
        (block) => block.type === 'reasoningBlock' && block.providerData?.provider === 'openai_responses'
      )
    )
    expect(replayed).toBe(true)
  })
})
