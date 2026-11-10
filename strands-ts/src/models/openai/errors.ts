/**
 * Shared error classification for the OpenAI model provider.
 *
 * @internal
 */

/**
 * Error message patterns that indicate context window overflow.
 *
 * @see https://platform.openai.com/docs/guides/error-codes
 */
// Union of overflow phrases observed across OpenAI responses, matched
// case-insensitively. Lowercased here so the comparison is a single
// ``toLowerCase`` on the error message.
const CONTEXT_WINDOW_OVERFLOW_PATTERNS = [
  'maximum context length',
  'context_length_exceeded',
  'too many tokens',
  'context length',
  'input is too long for requested model',
  'input length and `max_tokens` exceed context limit',
  'too many total text bytes',
  'exceed customer model maximum',
]

/**
 * Error patterns that indicate rate limiting.
 *
 * @see https://platform.openai.com/docs/guides/error-codes
 */
const RATE_LIMIT_PATTERNS = ['rate_limit_exceeded', 'rate limit', 'too many requests']

export type OpenAIErrorKind = 'contextOverflow' | 'throttling'

/**
 * Classifies an OpenAI SDK error.
 *
 * @internal
 */
export function classifyOpenAIError(err: Error & { status?: number; code?: string }): OpenAIErrorKind | undefined {
  const message = err.message?.toLowerCase() ?? ''
  // The OpenAI SDK types `code` as a string, but OpenAI-compatible providers (e.g. OpenRouter)
  // can return a number (`{ "error": { "code": 400 } }`). Guard with `typeof` before calling
  // `.toLowerCase()` so a non-string code falls back to '' instead of throwing a TypeError.
  const code = typeof err.code === 'string' ? err.code.toLowerCase() : ''

  if (err.status === 429 || code === 'rate_limit_exceeded' || RATE_LIMIT_PATTERNS.some((p) => message.includes(p))) {
    return 'throttling'
  }

  if (code === 'context_length_exceeded' || CONTEXT_WINDOW_OVERFLOW_PATTERNS.some((p) => message.includes(p))) {
    return 'contextOverflow'
  }

  return undefined
}
