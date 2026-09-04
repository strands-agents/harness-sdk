# strandly experiment

An experimentation framework for understanding how SDK changes affect agent behavior.

## What this is

This is NOT a test suite. Nothing "passes" or "fails" in the traditional sense.
The scenarios are **workloads** — they run real agent interactions that exercise
different SDK subsystems (context management, tool dispatch, streaming, interrupts).
The framework captures detailed behavioral data from each run: how many cycles
the agent took, how context grew, what the model reasoned about, how tools were
dispatched.

The value comes from **comparing runs**. You make an SDK change, run the same
workloads, and compare the behavioral data. The comparison tells you what your
change actually did to agent behavior — not whether it's "correct," but what
shifted and by how much.

## Quick start

```bash
# Run a baseline on clean HEAD
bash strandly/experiment/run.sh --as baseline

# Make your SDK change, then run again
bash strandly/experiment/run.sh --as my-change
```

## How it works

1. You make a change to `strands-ts/src/` (or edit `src/agent-factory.ts` to
   experiment with agent configuration).
2. The suite runs workloads that exercise the SDK subsystems relevant to your
   change. Each workload generates behavioral data: cycle counts, token usage,
   context size, model latency, tool call patterns, and the model's reasoning.
3. You compare run JSON files to see what shifted — cycles, tokens, context
   peaks, invariant status. The saved runs at `runs/<name>.json` contain all
   the data; transcripts at `runs/transcripts/<name>/` show the model's reasoning.

## What you get from a run

Each run produces:

- **Metrics per invocation** — cycles, input/output tokens, cache tokens, context
  size, model latency, tool call timing and result sizes
- **Transcripts** — the model's reasoning between tool calls, grouped by invocation
  (`runs/transcripts/{id}/{scenario}.txt`)
- **Invariants** — deterministic SDK-contract checks (tool pairing, history
  continuity, state consistency). These are not pass/fail gates — they're one
  signal among many. A status change between runs points at a specific mechanism
  that shifted.
- **Working-tree patch** — the `git diff` at run time, stored with the run so
  you can always see what code produced the behavior

## Comparing runs

Compare by reading the JSON files at `runs/<name>.json`. Each contains:

- **Invariants** — deterministic SDK-contract checks (tool pairing, history
  ordering, context bounds, scenario-specific state)
- **Per-invocation metrics** — cycles, tokens, context size, cache hits,
  model latency, tool calls with timing
- **Source version** — git sha + working-tree patch at run time

Transcripts at `runs/transcripts/<name>/<scenario>.txt` show the model's
reasoning between tool calls — useful for understanding *why* behavior shifted.

## CLI

```bash
bash run.sh --as my-experiment           # run all scenarios
bash run.sh --as test paginated          # filter by scenario name substring
bash run.sh --dim context-management     # filter by SDK dimension
bash run.sh --fast                       # synthetic-tool scenarios only
bash run.sh list                         # list saved runs
bash run.sh dims                         # list dimensions and which scenarios each selects
bash run.sh transcript my-run paginated  # view transcript for a scenario
bash run.sh --script foo.ts              # run a custom script directly
```

`--as <name>` is required. Runs are saved as `runs/<name>.json`. Using a name
that already exists is an error — pick a new name or delete the old run first.

Env vars: `CONCURRENCY=8` (parallel scenario count, default 4).

## Agent factory (`src/agent-factory.ts`)

Every scenario calls `createAgent(profiler, requirements)`. You own the full
`new Agent(...)` construction — the scenario passes what it needs (tools, system
prompt, suggested window size), and you build the agent however you want. The
only rule: include `profiler` in plugins so the framework can observe.

## Dimensions

Scenarios tag themselves with the SDK surface areas they exercise. Use `--dim`
to run only scenarios relevant to your change.

| Dimension | What it covers |
|---|---|
| `context-management` | Sliding window, truncation, summarization, context overflow |
| `tool-dispatch` | Tool call lifecycle, parallel dispatch, result handling |
| `state-consistency` | External state via tools, lost updates, in-band errors |
| `interrupt-resume` | Interrupt/resume cycle, history preservation across pauses |
| `agent-loop` | Cycle budgets, stop reasons, backtracking, retries |
| `nested-agents` | Agent-as-tool, result serialization into parent context |
| `streaming` | Model response streaming, chunk assembly |
| `caching` | Prompt caching, cache token accounting |

Run `bash run.sh dims` to see which scenarios each dimension selects.

## Invariants

Deterministic SDK-contract checks recorded after each scenario runs. These are
**not gates** — they are one axis of behavioral data. Their value is comparative:

- **tool-pairing-intact** — every tool_use has its tool_result and vice versa
- **history-well-formed** — no tool_result precedes its tool_use
- **context-under-window** — message count stayed within configured bounds
- **Scenario-specific state checks** — e.g. queue fully drained, room capacity
  respected, all API paths exercised

A status change between runs is a strong signal pointing at a specific mechanism.
A stable status tells you that mechanism wasn't affected.

## Transcripts

Each run saves the model's reasoning (assistant text blocks between tool calls)
to `runs/transcripts/<id>/<scenario-name>.txt`, grouped by invocation with
metrics headers. These exist for interpretation — when you see a cycle count
shift in the comparison, the transcript explains what the model was doing
differently.

## Evaluation rubrics

Some scenarios include a `rubric` field describing what a correct output looks
like. These are reference context for interpreting behavior, not scoring criteria.

## Writing a custom scenario

```typescript
import { createAgent } from '../src/agent-factory.js'
import { bash } from '../../strands-ts/src/vended-tools/bash/index.js'
import { scenario } from '../src/scenario.js'
import type { ProfilerObserver } from '../src/observer.js'

export default scenario({
  description: 'Find every test file in the repo.',
  stresses: 'Plain bash discovery — a baseline for tool-call overhead.',
  dimensions: ['tool-dispatch'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const agent = createAgent(profiler, {
    systemPrompt: 'Find test files using bash.',
    tools: [bash],
    windowSize: 10,
  })

  profiler.recordInvocationInput('Find all test files.')
  const result = await agent.invoke('Find all test files.')
  profiler.recordResult(result)
}
```

Call `recordInvocationInput` before each `invoke()` and `recordResult` after.

## Tools library

Building blocks for scenarios (beyond SDK vended tools):

- `makeDatabase(options?)` — paginated SQL-like database with verbose JSON responses, optional rate limiting
- `makeKvStore(options?)` — paginated key-value store with versioning, CAS, optional stale-read unreliability
- `makeApiMock(endpoints, options?)` — REST API mock with verbose responses, optional transient 500s/429s
- `makeTaskQueue(tasks, options?)` — prioritized queue with dependencies, optional stale-pop unreliability

## External benchmarks (`benchmarks/`)

### τ-bench

Multi-turn customer service benchmark (Sierra Research, MIT). Tests end-to-end
agent capability on realistic tasks with deterministic scoring. Not a substitute
for the bespoke scenarios — it's a sanity check that the SDK works correctly
under normal use, not a targeted stress test of specific mechanisms.

```bash
bash benchmarks/tau-bench/setup.sh            # one-time setup
TAU_BENCH_LIMIT=10 bash run.sh --as test tau-bench  # 10 tasks, ~10 min
```

See `benchmarks/tau-bench/README.md` for full docs (configuration, architecture,
task difficulty, when to use vs bespoke scenarios).
