import { describe, expect, inject, it } from 'vitest'
import { z } from 'zod'

import { tool } from '@strands-agents/sdk'
import { BidiAgent, OpenAIRealtimeModel } from '$/sdk/bidi/index.js'
import type { BidiAgentConfig } from '$/sdk/bidi/index.js'
import { assistantText, runOneTurn, textThenSilence } from '../__fixtures__/bidi-helpers.js'

// Runs in both integ projects: Node authenticates with headers, Chromium with websocket subprotocols.
const openai = inject('provider-openai')

describe.skipIf(openai.shouldSkip)('OpenAIRealtimeModel', () => {
  const createAgent = (config: Omit<BidiAgentConfig, 'model'> = {}): BidiAgent =>
    new BidiAgent({
      model: new OpenAIRealtimeModel({ modelId: 'gpt-realtime', transcriptionModelId: null, apiKey: openai.apiKey! }),
      systemPrompt: 'Answer in one short sentence.',
      ...config,
    })

  it('answers a text question', async () => {
    const events = await runOneTurn(createAgent(), (signal) => textThenSilence('What is two plus two?', 24000, signal))

    expect(events.some((event) => event.type === 'bidiConnectionStart')).toBe(true)
    expect(assistantText(events).toLowerCase()).toMatch(/four|4/)
  })

  it('calls a tool and uses its result', async () => {
    const secretWord = tool({
      name: 'get_secret_word',
      description: 'Return the secret word.',
      inputSchema: z.object({}),
      callback: () => 'pineapple',
    })

    const events = await runOneTurn(createAgent({ tools: [secretWord] }), (signal) =>
      textThenSilence('Use the get_secret_word tool and tell me the secret word.', 24000, signal)
    )

    expect(events.some((event) => event.type === 'bidiToolUseBlocks')).toBe(true)
    expect(assistantText(events).toLowerCase()).toContain('pineapple')
  })
})
