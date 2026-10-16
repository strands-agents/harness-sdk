/**
 * Interfaces for bidirectional input and output streams.
 *
 * The interfaces separate input and output concerns into independent streams with lifecycle
 * methods managed by `BidiAgent.run()`.
 */

import type { BidiAgent } from '../agent/agent.js'
import type { BidiAgentInput } from './agent.js'
import type { BidiOutputEvent } from './events.js'

/**
 * Input stream managed by a bidirectional agent.
 *
 * An input stream reads one value from a source each time the agent calls `read()`.
 */
export interface BidiInputStream {
  /**
   * Start input.
   *
   * @param agent - The agent that owns this stream
   */
  start?(agent: BidiAgent): Promise<void>

  /** Stop input. */
  stop?(): Promise<void>

  /**
   * Read input data from the source.
   *
   * @returns Promise that resolves to input content (audio, text, image, etc.)
   */
  read(): Promise<BidiAgentInput>
}

/**
 * Output stream managed by a bidirectional agent.
 *
 * An output stream handles one event each time the agent calls `write()`.
 */
export interface BidiOutputStream {
  /**
   * Start output.
   *
   * @param agent - The agent that owns this stream
   */
  start?(agent: BidiAgent): Promise<void>

  /** Stop output. */
  stop?(): Promise<void>

  /**
   * Process an output event from the agent.
   *
   * @param event - Output event from the agent (audio, text, tool calls, etc.)
   */
  write(event: BidiOutputEvent): Promise<void>
}

/**
 * An input accepted by `BidiAgent.run()`: a {@link BidiInputStream}, or any async iterable of
 * agent input (for example an async generator). An iterable has no `start`/`stop` lifecycle; once
 * it is exhausted the run keeps going until another stream ends it or the run is cancelled.
 */
export type BidiRunInput = BidiInputStream | AsyncIterable<BidiAgentInput>

/**
 * An output accepted by `BidiAgent.run()`: a {@link BidiOutputStream}, or a callback invoked with
 * every event the agent produces.
 */
export type BidiRunOutput = BidiOutputStream | ((event: BidiOutputEvent) => void | Promise<void>)
