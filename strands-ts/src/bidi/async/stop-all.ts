/**
 * Sequential stop helper for bidirectional components.
 *
 * @internal
 */

/** A stop function managed by {@link stopAll}. */
export type StopFunction = () => Promise<void>

/**
 * Call all stops in sequence and aggregate errors.
 *
 * A failure in one stop call does not block subsequent stop calls.
 *
 * @internal
 * @param stops - Stop functions to call in sequence
 * @throws {@link Error} If any stop function throws
 */
export async function stopAll(...stops: StopFunction[]): Promise<void> {
  const failures: string[] = []

  for (const stop of stops) {
    try {
      await stop()
    } catch (error) {
      failures.push(`${stop.name || 'anonymous'}: ${String(error)}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`errors=<${failures.join(', ')}> | failed stop sequence`)
  }
}
