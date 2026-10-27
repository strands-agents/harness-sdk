export interface ToolCallTrace {
  name: string
  input: unknown
  output: string
  durationMs: number
  success: boolean
  error?: string
  resultSize: number
}

export interface InvocationTrace {
  input: string
  output: string
  durationMs: number
  cycleCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Input tokens served from prompt cache this invocation. A change that
   *  improves caching shows up here as cost the agent didn't re-pay. */
  cacheReadTokens: number
  /** Input tokens written to prompt cache this invocation. */
  cacheWriteTokens: number
  /** Model latency for THIS invocation in ms (the SDK only exposes a
   *  session-cumulative total, so this is diffed across invocations).
   *  Distinct from `durationMs`, which is wall-clock incl. tool + overhead. */
  modelLatencyMs: number
  /** Input-token count of the last model call — i.e. how full the context
   *  window got. The scenarios that stress truncation/context pressure are
   *  exactly the ones this makes observable. */
  contextSize: number
  stopReason: string
  messageCountAfter: number
  toolCalls: ToolCallTrace[]
}

export interface ScenarioResult {
  name: string
  description: string
  stresses: string
  dimensions: string[]
  /** What correct looks like (rubric + optional expected output). Stored as
   *  context for a reader judging the output — not auto-scored. */
  evaluation?: { rubric: string; expectedOutput?: string }
  /** Deterministic SDK-invariant results — the primary signal. Recorded by
   *  the scenario via `profiler.recordInvariants(...)` after the agent runs.
   *  Each is a code-checked boolean tied to SDK behavior (tool pairing,
   *  history continuity, state consistency), immune to model strength. */
  invariants?: { name: string; status: 'pass' | 'fail' | 'skip'; detail: string }[]
  durationMs: number
  invocations: InvocationTrace[]
  errors: string[]
}

export interface SourceVersion {
  gitSha: string
  gitDirty: boolean
  /** Working-tree diff at run time (`git diff`). Present only when the tree was dirty. */
  patch?: string
}

export interface SuiteResult {
  /** Human-given label for what this run represents — e.g. "baseline",
   *  "window-fix". The anchor for an A/B: it says what the change WAS, which
   *  a bare git SHA can't. Defaults to "unnamed" when not supplied. */
  experiment: string
  timestamp: string
  totalDurationMs: number
  sourceVersion: SourceVersion
  scenarios: ScenarioResult[]
}
