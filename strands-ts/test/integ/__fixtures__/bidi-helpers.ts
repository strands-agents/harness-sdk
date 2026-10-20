/**
 * Helpers for bidi integration tests that run in both Node and the browser.
 */
import { AudioDelta } from '$/sdk/bidi/index.js'
import type { BidiAgent, BidiAgentInput, BidiOutputEvent } from '$/sdk/bidi/index.js'

/**
 * Yield a text message, then stream PCM silence until aborted. Some models (Nova Sonic) only answer
 * once an audio input stream is open, and silence keeps server-side turn detection from stalling.
 */
export async function* textThenSilence(
  text: string,
  sampleRate: number,
  signal: AbortSignal
): AsyncGenerator<BidiAgentInput> {
  yield text
  const chunkMs = 32
  const bytes = new Uint8Array(((sampleRate * chunkMs) / 1000) * 2)
  while (!signal.aborted) {
    yield new AudioDelta({ format: 'pcm', source: { bytes } })
    await new Promise((resolve) => setTimeout(resolve, chunkMs))
  }
}

/**
 * Run the agent on the given inputs until the first response that produced an assistant transcript
 * or text stops, collecting every output event.
 */
export async function runOneTurn(
  agent: BidiAgent,
  inputs: (signal: AbortSignal) => AsyncIterable<BidiAgentInput>
): Promise<BidiOutputEvent[]> {
  const events: BidiOutputEvent[] = []
  const done = new AbortController()
  await agent.run({
    inputs: [inputs(done.signal)],
    outputs: [
      (event) => {
        events.push(event)
        if (event.type === 'bidiResponseStop' && assistantText(events).length > 0) done.abort()
      },
    ],
    cancelSignal: done.signal,
  })
  return events
}

/** Concatenate the assistant's transcripts and text blocks. */
export function assistantText(events: BidiOutputEvent[]): string {
  return events
    .flatMap((event) => {
      if (event.type === 'bidiTranscriptBlock' && event.role === 'assistant') return [event.transcript]
      if (event.type === 'bidiTextBlock') return [event.text]
      return []
    })
    .join(' ')
}
