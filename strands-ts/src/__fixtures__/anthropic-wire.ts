import Anthropic from '@anthropic-ai/sdk'

/** One request the wire saw: its path, headers, and the exact body bytes. */
export interface RecordedRequest {
  path: string
  headers: Record<string, string>
  body: string
}

/** A canned response: the content blocks and stop reason of one Messages API reply. */
export interface CannedReply {
  content?: Record<string, unknown>[]
  stopReason?: string
  usage?: Record<string, unknown>
  /** HTTP status; a non-2xx status returns `error` as the JSON body. */
  status?: number
  error?: Record<string, unknown>
}

/**
 * A fail-closed Anthropic transport. Each request takes the next canned reply; a request with no reply
 * left throws, so no test can reach the network. Every body is recorded byte for byte.
 */
export class AnthropicWire {
  readonly requests: RecordedRequest[] = []
  private readonly _replies: CannedReply[] = []
  private _responder: ((body: Record<string, unknown>) => CannedReply | undefined) | undefined

  /**
   * Queue replies, served in order.
   *
   * @param replies - Replies to serve
   * @returns This wire
   */
  reply(...replies: CannedReply[]): this {
    this._replies.push(...replies)
    return this
  }

  /**
   * Answer requests from their parsed body instead of the queue; a request it returns nothing for throws.
   *
   * @param responder - Picks the reply for a request
   * @returns This wire
   */
  respond(responder: (body: Record<string, unknown>) => CannedReply | undefined): this {
    this._responder = responder
    return this
  }

  /**
   * A real SDK client whose only transport is this wire.
   *
   * @param defaultHeaders - Client default headers
   * @returns The client
   */
  client(defaultHeaders?: Record<string, string>): Anthropic {
    // The key is a placeholder and every request stays on this wire, so the client may run in a browser test.
    return new Anthropic({
      apiKey: 'offline-test-key',
      maxRetries: 0,
      fetch: this._fetch,
      dangerouslyAllowBrowser: true,
      ...(defaultHeaders && { defaultHeaders }),
    })
  }

  /** Bodies parsed as JSON, in request order. */
  get bodies(): Record<string, unknown>[] {
    return this.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>)
  }

  private readonly _fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    this.requests.push({ path: url.pathname + url.search, headers, body: String(init?.body ?? '') })
    const body = String(init?.body ?? '')
    const reply = this._responder ? this._responder(JSON.parse(body) as Record<string, unknown>) : this._replies.shift()
    if (!reply) throw new Error(`unmocked request to ${url.pathname}`)
    if (reply.status !== undefined && reply.status >= 400) {
      return new Response(JSON.stringify({ type: 'error', error: reply.error ?? {} }), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(sse(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

function sse(reply: CannedReply): string {
  const usage = reply.usage ?? { input_tokens: 10, output_tokens: 5 }
  const events: [string, Record<string, unknown>][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_offline',
          type: 'message',
          role: 'assistant',
          model: 'offline',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 },
        },
      },
    ],
  ]
  ;(reply.content ?? []).forEach((block, index) => {
    events.push(...blockEvents(block, index))
  })
  events.push(
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: reply.stopReason ?? 'end_turn', stop_sequence: null }, usage },
    ],
    ['message_stop', { type: 'message_stop' }]
  )
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function blockEvents(block: Record<string, unknown>, index: number): [string, Record<string, unknown>][] {
  const stop: [string, Record<string, unknown>] = ['content_block_stop', { type: 'content_block_stop', index }]
  if (block.type === 'text') {
    return [
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }],
      stop,
    ]
  }
  if (block.type === 'thinking') {
    return [
      [
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } },
      ],
      stop,
    ]
  }
  if (block.type === 'tool_use') {
    return [
      ['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      ],
      stop,
    ]
  }
  // Blocks that arrive whole, such as an on-demand compaction block.
  return [['content_block_start', { type: 'content_block_start', index, content_block: block }], stop]
}
