import { describe, expect, inject, it } from 'vitest'

import { BedrockNovaSonicModel, BidiAgent, OpenAIRealtimeModel } from '$/sdk/bidi/index.js'
import type { BidiModel, BidiOutputEvent } from '$/sdk/bidi/index.js'
import { BrowserAudioIO } from '$/sdk/bidi/io/browser-audio.js'
import { GoogleGeminiLiveModel } from '$/sdk/bidi/models/google.js'
import { assistantText } from '../__fixtures__/bidi-helpers.js'

// The integ-browser project launches Chromium with a fake microphone that speaks
// test/integ/__resources__/what-is-two-plus-two.wav on a loop, so these tests exercise the full
// audio path: getUserMedia -> AudioWorklet capture -> resampling -> model -> playback.

/** Listen through BrowserAudioIO until the model has answered the spoken question. */
async function answerSpokenQuestion(model: BidiModel): Promise<BidiOutputEvent[]> {
  const agent = new BidiAgent({ model, systemPrompt: 'Answer in one short sentence.' })
  const audio = new BrowserAudioIO()
  const events: BidiOutputEvent[] = []
  const done = new AbortController()
  const timeout = setTimeout(() => done.abort(), 40_000)
  try {
    await agent.run({
      inputs: [audio.input()],
      outputs: [
        audio.output(),
        (event) => {
          events.push(event)
          if (event.type === 'bidiResponseStop' && /four|\b4\b/i.test(assistantText(events))) done.abort()
        },
      ],
      cancelSignal: done.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  return events
}

const bedrock = inject('provider-bedrock')
const openai = inject('provider-openai')
const gemini = inject('provider-gemini')

describe('BrowserAudioIO with a live model', () => {
  it.skipIf(bedrock.shouldSkip)(
    'answers a spoken question with Nova Sonic',
    async () => {
      const events = await answerSpokenQuestion(
        new BedrockNovaSonicModel({ region: 'us-east-1', clientConfig: { credentials: bedrock.credentials! } })
      )

      expect(events.some((event) => event.type === 'bidiAudioDelta')).toBe(true)
      expect(assistantText(events).toLowerCase()).toMatch(/four|\b4\b/)
    },
    60_000
  )

  it.skipIf(openai.shouldSkip)(
    'answers a spoken question with OpenAI Realtime',
    async () => {
      const events = await answerSpokenQuestion(
        new OpenAIRealtimeModel({
          modelId: 'gpt-realtime',
          transcriptionModelId: 'gpt-4o-transcribe',
          apiKey: openai.apiKey!,
        })
      )

      expect(events.some((event) => event.type === 'bidiAudioDelta')).toBe(true)
      expect(assistantText(events).toLowerCase()).toMatch(/four|\b4\b/)
    },
    60_000
  )

  it.skipIf(gemini.shouldSkip)(
    'answers a spoken question with Gemini Live',
    async () => {
      const events = await answerSpokenQuestion(
        new GoogleGeminiLiveModel({ modelId: 'gemini-live-2.5-flash-preview', apiKey: gemini.apiKey! })
      )

      expect(events.some((event) => event.type === 'bidiAudioDelta')).toBe(true)
      expect(assistantText(events).toLowerCase()).toMatch(/four|\b4\b/)
    },
    60_000
  )
})
