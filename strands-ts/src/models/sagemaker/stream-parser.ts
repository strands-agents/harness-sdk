/**
 * SSE stream parser for SageMaker OpenAI-compatible endpoints.
 *
 * SageMaker `InvokeEndpointWithResponseStream` returns `PayloadPart` chunks
 * that are not aligned to event boundaries. This parser buffers bytes and
 * yields decoded JSON events, mirroring the Python SDK's `_parse_event_stream`.
 *
 * @internal
 */

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

/**
 * Decoded JSON event from the stream, matching the OpenAI Chat Completions
 * streaming response shape.
 */
export interface StreamChunk {
  choices?: Array<{
    index: number
    delta?: {
      role?: string
      content?: string
      reasoning_content?: string
      reasoning?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Parses a SageMaker response stream into decoded JSON events.
 *
 * Each `PayloadPart` is an arbitrary byte chunk that may contain multiple
 * SSE events or split one across parts. The parser buffers bytes and
 * yields one decoded object per complete event.
 */
export async function* parseEventStream(
  body: AsyncIterable<{ PayloadPart?: { Bytes?: Uint8Array } }>
): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const part of body) {
    const bytes = part.PayloadPart?.Bytes
    if (!bytes) continue

    buffer += decoder.decode(bytes, { stream: true })
    logger.debug(`buffer=<${buffer.slice(0, 200)}...> | accumulated payload part`)

    // Process complete lines
    while (buffer.includes('\n')) {
      const nlIndex = buffer.indexOf('\n')
      const line = buffer.slice(0, nlIndex)
      const rest = buffer.slice(nlIndex + 1)

      const payload = stripSseFraming(line)
      if (payload === undefined) {
        buffer = rest
        continue
      }

      try {
        const event = JSON.parse(payload) as StreamChunk
        buffer = rest
        yield event
      } catch {
        // Not SSE-framed bare JSON that only decodes as a whole document.
        // Stop line-splitting and let the whole-buffer decode below retry.
        if (!line.trimStart().startsWith('data:')) {
          break
        }
        logger.warn(`line=<${line}> | skipping malformed event`)
        buffer = rest
      }
    }

    // Try to parse the entire buffer as a single JSON object
    // (for endpoints that send non-newline-framed responses)
    const payload = stripSseFraming(buffer)
    if (payload === undefined) continue
    try {
      const parsed = JSON.parse(payload) as StreamChunk
      buffer = ''
      yield parsed
    } catch {
      // Buffer is incomplete; wait for more data
    }
  }

  if (stripSseFraming(buffer) !== undefined) {
    logger.warn(`buffer=<${buffer.slice(0, 200)}> | stream ended with an undecoded partial event`)
  }
}

/**
 * Parses a non-streaming (synchronous) SageMaker response body.
 */
export function parseResponseBody(body: Uint8Array): StreamChunk {
  const text = new TextDecoder().decode(body)
  return JSON.parse(text) as StreamChunk
}
