import type { Node } from './nodes.js'
import type { MultiAgentState } from './state.js'

/**
 * Evaluates whether an edge should be traversed based on the current execution state.
 */
export type EdgeHandler = (state: MultiAgentState) => boolean | Promise<boolean>

/**
 * Directed edge between two nodes.
 */
export class Edge {
  readonly source: Node
  readonly target: Node
  /** Edge condition. The edge is always traversed when no handler is provided. */
  readonly handler: EdgeHandler

  constructor(data: { source: Node; target: Node; handler?: EdgeHandler }) {
    this.source = data.source
    this.target = data.target
    this.handler = data.handler ?? ((): boolean => true)
  }
}

/**
 * Options for creating an edge with an optional condition handler.
 */
export interface EdgeOptions {
  source: string
  target: string
  handler?: EdgeHandler
}

/**
 * An edge definition accepted by orchestration constructors.
 *
 * Pass a `[source, target]` tuple for the simple case, or {@link EdgeOptions}
 * when per-edge configuration is needed.
 */
export type EdgeDefinition = [source: string, target: string] | EdgeOptions
