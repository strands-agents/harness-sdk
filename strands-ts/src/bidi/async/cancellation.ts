/**
 * Cancellation helpers shared by the bidirectional async utilities.
 *
 * @internal
 */

import { CancelledError } from '../../errors.js'

/**
 * Whether an error represents cooperative cancellation rather than a task failure.
 *
 * Covers the SDK's {@link CancelledError} and the `AbortError` that `AbortSignal`-aware APIs
 * reject with, so cancelling siblings never masks the failure that triggered the cancellation.
 *
 * @internal
 * @param error - The rejection reason to classify
 * @returns true if the error is a cancellation
 */
export function isCancellation(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError')
}
