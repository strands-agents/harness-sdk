import { describe, expect, inject, it } from 'vitest'
import { z } from 'zod'

import { tool } from '@strands-agents/sdk'
import { BedrockNovaSonicModel, BidiAgent } from '$/sdk/bidi/index.js'
import type { BidiAgentConfig } from '$/sdk/bidi/index.js'
import { assistantText, runOneTurn, textThenSilence } from '../__fixtures__/bidi-helpers.js'

// Runs in both integ projects: in Node the AWS SDK streams over HTTP/2, in Chromium over a signed WebSocket.
const bedrock = inject('provider-bedrock')

describe.skipIf(bedrock.shouldSkip)('BedrockNovaSonicModel', () => {
  const createAgent = (config: Omit<BidiAgentConfig, 'model'> = {}): BidiAgent =>
    new BidiAgent({
      model: new BedrockNovaSonicModel({ region: 'us-east-1', clientConfig: { credentials: bedrock.credentials! } }),
      systemPrompt: 'Answer in one short sentence.',
      ...config,
    })

  it('answers a text question with speech', async () => {
    const events = await runOneTurn(createAgent(), (signal) => textThenSilence('What is two plus two?', 16000, signal))

    expect(events.some((event) => event.type === 'bidiConnectionStart')).toBe(true)
    expect(events.some((event) => event.type === 'bidiAudioDelta')).toBe(true)
    expect(assistantText(events).toLowerCase()).toMatch(/four|4/)
  })

  it('calls a tool and speaks its result', async () => {
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
