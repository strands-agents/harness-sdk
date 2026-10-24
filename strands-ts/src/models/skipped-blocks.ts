/**
 * Aggregation of per-block skip notices raised while formatting a request.
 *
 * @internal This module is not part of the public API.
 */

import type { Logger } from '../logging/types.js'

/**
 * Count of skipped blocks keyed by the notice message.
 *
 * @internal
 */
export type SkippedBlocks = Map<string, number>

/**
 * Records one skipped block under its notice message.
 *
 * @internal
 */
export function countSkipped(skipped: SkippedBlocks, message: string): void {
  skipped.set(message, (skipped.get(message) ?? 0) + 1)
}

/**
 * Logs each skip notice once with the number of blocks it covers.
 *
 * Formatters re-format the full history on every request, so a notice logged per
 * skipped block repeats for every earlier message on every request. Formatters
 * count notices while they format and call this once at the end instead.
 *
 * @param logger - The provider module's logger, so records keep the provider's logger name.
 * @param skipped - Count of skipped blocks per notice message.
 *
 * @internal
 */
export function logSkippedBlocks(logger: Logger, skipped: SkippedBlocks): void {
  for (const [message, count] of skipped) {
    logger.warn(`count=<${count}> | ${message}`)
  }
}
