/**
 * SSE stream parser for SageMaker OpenAI-compatible endpoints.
 *
 * SageMaker `InvokeEndpointWithResponseStream` returns `PayloadPart` chunks
 * that are not aligned to event boundaries. This parser buffers bytes and
 * yields decoded JSON events, mirroring the Python SDK's `_parse_event_stream`.
 *
 * @internal
 */

import { ModelError } from '../../errors.js'
import { logger } from '../../logging/logger.js'

/**
 * Strips SSE framing from a single line and returns the JSON payload, or
 * `undefined` if the line carries no event data.
 */
function stripSseFraming(line: string): string | undefined {
  line = line.trim()
  if (line.startsWith('data:')) {
    line = line.slice(5).trim()
  } else if (line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
    return undefined
  }
  if (!line || line.startsWith(':') || line === '[DONE]') {
    return undefined
  }
  return line
}

/** One event of the `InvokeEndpointWithResponseStream` response body. */
export interface ResponseStreamPart {
  PayloadPart?: { Bytes?: Uint8Array }
  ModelStreamError?: Error
  InternalStreamFailure?: Error
}

/** Token usage as OpenAI-compatible containers report it. */
export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

/** One tool call fragment within a streamed delta. */
export interface ChatToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

/** One choice of a Chat Completions streaming chunk. */
export interface ChatChoice {
  index: number
  delta?: {
    role?: string
    content?: string | null
    reasoning_content?: string
    reasoning?: string
    tool_calls?: ChatToolCallDelta[]
  }
  finish_reason?: string | null
  usage?: ChatUsage
}

/**
 * Decoded JSON event from the stream, matching the OpenAI Chat Completions
 * streaming response shape.
 */
export interface StreamChunk {
  choices?: ChatChoice[]
  usage?: ChatUsage
}

/**
 * Parses a SageMaker response stream into decoded JSON events.
 *
 * Each `PayloadPart` is an arbitrary byte chunk that may contain multiple
 * SSE events or split one across parts. The parser buffers bytes and
 * yields one decoded object per complete event.
 */
export async function* parseEventStream(body: AsyncIterable<ResponseStreamPart>): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder()
  const buffer = new EventBuffer()

  for await (const part of body) {
    // A failure after the response started arrives as an event in the stream, not as a thrown error.
    const streamError = part.ModelStreamError ?? part.InternalStreamFailure
    if (streamError) throw streamError
    const bytes = part.PayloadPart?.Bytes
    if (!bytes) continue
    buffer.append(decoder.decode(bytes, { stream: true }))
    yield* buffer.drain()
  }

  if (buffer.hasPartialEvent()) {
    logger.warn(`buffer_length=<${buffer.length}> | stream ended with an undecoded partial event`)
  }
}

/** Marks a line that is part of a JSON document spanning several lines. */
const INCOMPLETE = Symbol('incomplete')

/** Text received but not yet decoded into events. */
class EventBuffer {
  private _text = ''

  get length(): number {
    return this._text.length
  }

  append(text: string): void {
    this._text += text
  }

  hasPartialEvent(): boolean {
    return stripSseFraming(this._text) !== undefined
  }

  /** Yields every complete event, then the whole remainder if it decodes on its own (unframed JSON). */
  *drain(): Generator<StreamChunk> {
    yield* this._drainLines()
    const payload = stripSseFraming(this._text)
    const whole = payload === undefined ? undefined : tryParse(payload)
    if (whole === undefined) return
    this._text = ''
    yield whole
  }

  private *_drainLines(): Generator<StreamChunk> {
    for (let end = this._text.indexOf('\n'); end !== -1; end = this._text.indexOf('\n')) {
      const event = parseLine(this._text.slice(0, end))
      // Bare JSON spread over several lines decodes only as a whole, which drain() retries.
      if (event === INCOMPLETE) return
      this._text = this._text.slice(end + 1)
      if (event !== undefined) yield event
    }
  }
}

/** The event on one line, `undefined` for a line without one, or {@link INCOMPLETE}. */
function parseLine(line: string): StreamChunk | undefined | typeof INCOMPLETE {
  const payload = stripSseFraming(line)
  if (payload === undefined) return undefined
  const event = tryParse(payload)
  if (event !== undefined) return event
  if (!line.trimStart().startsWith('data:')) return INCOMPLETE
  logger.warn(`line_length=<${line.length}> | skipping malformed event`)
  return undefined
}

function tryParse(payload: string): StreamChunk | undefined {
  try {
    const value = JSON.parse(payload) as unknown
    return typeof value === 'object' && value !== null ? (value as StreamChunk) : undefined
  } catch {
    return undefined
  }
}

/**
 * Parses a non-streaming (synchronous) SageMaker response body.
 */
export function parseResponseBody(body: Uint8Array): unknown {
  const text = new TextDecoder().decode(body)
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new ModelError('SageMaker endpoint returned a non-JSON response', { cause })
  }
}
