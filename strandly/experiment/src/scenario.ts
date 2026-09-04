/**
 * Scenario interface — structured metadata + the run body.
 *
 * Replaces the free-text block comments that used to live at the top of each
 * scenario file. The metadata is machine-readable so it flows into the saved
 * run JSON and — eventually — into a Python port that shares the same catalog.
 */

import type { ProfilerObserver } from './observer.js'

/**
 * Fixed vocabulary of SDK surface areas. A scenario tags itself with the
 * dimensions it exercises so an agent can filter to only the relevant subset
 * for a given change — without reading 12 stresses paragraphs.
 */
export type Dimension =
  | 'context-management'   // sliding window, truncation, summarization, context overflow
  | 'tool-dispatch'        // tool call lifecycle, parallel dispatch, result handling
  | 'state-consistency'    // external state via tools, lost updates, in-band errors
  | 'interrupt-resume'     // interrupt/resume cycle, history preservation across pauses
  | 'agent-loop'           // cycle budgets, stop reasons, backtracking, retries
  | 'nested-agents'        // agent-as-tool, result serialization into parent context
  | 'streaming'            // model response streaming, chunk assembly
  | 'caching'              // prompt caching, cache token accounting

export interface ScenarioEvaluation {
  /** What a correct answer looks like — a rubric a reader (human or Claude) can
   *  judge the agent's final output against. Not auto-scored; just structured
   *  ground truth in the saved JSON for anyone reading the report. */
  rubric: string
  /** Optional reference answer for scenarios with a single correct output. */
  expectedOutput?: string
}

export interface Scenario {
  /** One-line, human- and port-readable summary of what the scenario does. */
  description: string
  /**
   * The SDK seam this probes — the "tension" the old block comments described.
   * Kept as prose, but as a field so it shows up in output instead of rotting
   * in a comment.
   */
  stresses: string
  /**
   * Which SDK surface areas this scenario exercises. An agent deciding which
   * scenarios to run for a given change matches these tags against the files/
   * subsystems the change touches. Multiple tags = the scenario sits at an
   * intersection (e.g. tool-dispatch + context-management for parallel calls
   * that spike context).
   */
  dimensions: Dimension[]
  /** Optional — what correct looks like. Stored in the saved JSON as context
   *  for a reader; not auto-scored. */
  evaluation?: ScenarioEvaluation
  /** The scenario body. Receives the profiler to attach + record against. */
  run: (profiler: ProfilerObserver) => Promise<void>
}

/** Identity helper for type inference + a stable authoring shape. */
export function scenario(s: Scenario): Scenario {
  return s
}
