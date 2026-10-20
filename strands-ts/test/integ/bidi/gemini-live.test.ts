import { describe, expect, inject, it } from 'vitest'
import { z } from 'zod'

import { tool } from '@strands-agents/sdk'
import { BidiAgent } from '$/sdk/bidi/index.js'
import type { BidiAgentConfig } from '$/sdk/bidi/index.js'
import { GoogleGeminiLiveModel } from '$/sdk/bidi/models/google.js'
import { assistantText, runOneTurn, textThenSilence } from '../__fixtures__/bidi-helpers.js'

// Runs in both integ projects; @google/genai opens its own WebSocket in Node and in the browser.
const gemini = inject('provider-gemini')

describe.skipIf(gemini.shouldSkip)('GoogleGeminiLiveModel', () => {
  const createAgent = (config: Omit<BidiAgentConfig, 'model'> = {}): BidiAgent =>
    new BidiAgent({
      model: new GoogleGeminiLiveModel({ modelId: 'gemini-live-2.5-flash-preview', apiKey: gemini.apiKey! }),
      systemPrompt: 'Answer in one short sentence.',
      ...config,
    })

  it('answers a text question', async () => {
    const events = await runOneTurn(createAgent(), (signal) => textThenSilence('What is two plus two?', 16000, signal))

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
      textThenSilence('Use the get_secret_word tool and tell me the secret word.', 16000, signal)
    )

    expect(events.some((event) => event.type === 'bidiToolUseBlocks')).toBe(true)
    expect(assistantText(events).toLowerCase()).toContain('pineapple')
  })
})
