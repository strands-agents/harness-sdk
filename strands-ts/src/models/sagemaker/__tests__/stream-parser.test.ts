import { describe, it, expect } from 'vitest'
import { parseEventStream, parseResponseBody } from '../stream-parser.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function makePayloadParts(texts: string[]): AsyncIterable<{ PayloadPart?: { Bytes?: Uint8Array } }> {
  const encoder = new TextEncoder()
  return (async function* () {
    for (const text of texts) {
      yield { PayloadPart: { Bytes: encoder.encode(text) } }
    }
  })()
}

async function collectChunks(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('parseEventStream', () => {
  it('parses SSE-framed events', async () => {
    const body = makePayloadParts([
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(2)
    expect((chunks[0] as any).choices[0].delta.content).toBe('Hi')
    expect((chunks[1] as any).choices[0].finish_reason).toBe('stop')
  })

  it('handles multiple events in a single payload part', async () => {
    const body = makePayloadParts([
      'data: {"choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null}]}\n\n',
    ])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(2)
    expect((chunks[0] as any).choices[0].delta.content).toBe('A')
    expect((chunks[1] as any).choices[0].delta.content).toBe('B')
  })

  it('handles events split across payload parts', async () => {
    const body = makePayloadParts([
      'data: {"choices":[{"inde',
      'x":0,"delta":{"content":"split"},"finish_reason":null}]}\n\n',
    ])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(1)
    expect((chunks[0] as any).choices[0].delta.content).toBe('split')
  })

  it('skips comment lines', async () => {
    const body = makePayloadParts([
      ': this is a comment\n',
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    ])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(1)
  })

  it('skips event: and id: lines', async () => {
    const body = makePayloadParts([
      'event: message\nid: 1\n',
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    ])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(1)
  })

  it('handles usage-only events (no choices)', async () => {
    const body = makePayloadParts(['data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(1)
    expect((chunks[0] as any).usage.prompt_tokens).toBe(10)
  })

  it('handles empty payload parts', async () => {
    const body = makePayloadParts([
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    ])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(1)
  })

  it('handles bare JSON (no data: prefix)', async () => {
    const body = makePayloadParts(['{"choices":[{"index":0,"delta":{"content":"bare"},"finish_reason":null}]}\n\n'])
    const chunks = await collectChunks(parseEventStream(body))
    expect(chunks).toHaveLength(1)
    expect((chunks[0] as any).choices[0].delta.content).toBe('bare')
  })
})

describe('parseResponseBody', () => {
  it('parses a JSON body', () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })
    )
    const result = parseResponseBody(body)
    expect(result.choices).toHaveLength(1)
    expect(result.usage?.prompt_tokens).toBe(3)
  })
})
