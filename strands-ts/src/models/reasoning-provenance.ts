/**
 * Provenance tags for provider-signed reasoning, so it reaches only models of the vendor that signed it.
 *
 * A signature or redacted payload is bound to the vendor that issued it, not to the endpoint or the exact model: the
 * same Claude signature is accepted through Bedrock and the Anthropic API and by other Claude models. Text-only
 * reasoning carries nothing provider-bound and stays untagged.
 *
 * @internal
 */

import type { ReasoningContentDelta } from './streaming.js'

/** @internal */
export const ANTHROPIC_REASONING = 'anthropic'

/** @internal */
export const GOOGLE_REASONING = 'google'

/**
 * `delta` with a provenance tag added when it carries a signature or redacted payload.
 *
 * @internal
 */
export function tagReasoningDelta(
  delta: ReasoningContentDelta,
  provider: string,
  modelId: string
): ReasoningContentDelta {
  if (!delta.signature && !delta.redactedContent) return delta
  return { ...delta, providerData: { provider, modelId, data: {} } }
}
