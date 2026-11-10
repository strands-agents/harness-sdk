import { expect } from 'vitest'

/**
 * Asymmetric matcher for a message's `trackingId` in whole-object assertions.
 *
 * `Message.trackingId` is a required `string`, but a minted UUID is non-deterministic, so tests
 * match it with `expect.any(String)`. Typed as `string` so it drops into a `Message`/`MessageData`
 * literal without a per-call-site cast.
 */
export const anyTrackingId = expect.any(String) as unknown as string
