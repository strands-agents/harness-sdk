/**
 * Default sleep tool with the built-in maximum duration.
 */

import { makeSleep } from './make-sleep.js'

/**
 * Default sleep tool. Pauses execution for up to 60 seconds and aborts
 * immediately when the agent invocation is cancelled.
 *
 * @example
 * ```typescript
 * // With an agent
 * const agent = new Agent({ tools: [sleep] })
 * await agent.invoke('Wait 2 seconds, then continue')
 *
 * // Direct usage
 * await sleep.invoke({ duration: 0.5 })
 * ```
 */
export const sleep = makeSleep()
