// Node entry point for `@strands-agents/sdk/decisions/http` (selected by the "node" export condition), so the
// Node-only credential chain stays out of browser bundles.
import { defaultProvider } from '@aws-sdk/credential-provider-node'

import { sigV4Auth as signWith, type HttpDecisionModelAuth, type SigV4AuthOptions } from './http-decision-model.js'

export * from './http-decision-model.js'

/**
 * Returns an {@link HttpDecisionModelAuth} that signs each request with AWS Signature Version 4, using the
 * standard AWS credential chain when `credentials` is omitted.
 * Query parameters named `__proto__` are unsupported by the signer and are rejected.
 *
 * @param options - What to sign for and with.
 * @throws Error if the service is empty, or no region is given or set in the environment.
 */
export function sigV4Auth(options: SigV4AuthOptions): HttpDecisionModelAuth {
  return signWith({ ...options, credentials: options.credentials ?? defaultProvider() })
}
