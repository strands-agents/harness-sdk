---
name: strandly-experiment
description: Run the experiment suite to test SDK changes. Only invoke when the user explicitly types /strandly-experiment — do not suggest or invoke proactively.
---

# Strandly Experiment Suite

14 pre-built agent scenarios that run against your local `strands-ts/` source
with full observability. You configure one file — `strandly/experiment/src/agent-factory.ts`
— which controls the model, conversation manager, plugins, and retry strategy.
Then every scenario runs with that configuration and captures per-invocation
metrics (cycles, tokens, context growth, cache hits, tool dispatch patterns,
invariants). Compare two named runs to see exactly what your SDK change did.

## How it works

1. Edit `strandly/experiment/src/agent-factory.ts` (or the SDK source you're testing)
2. Run: `bash strandly/experiment/run.sh --as my-change`
3. Read the run JSON (`runs/my-change.json`) and transcripts (`runs/transcripts/my-change/`)

The scenarios provide the workloads. You provide the SDK configuration.
The run artifact contains all the behavioral data.

## What the output contains

The comparison output includes:
- The git diff (what code changed between runs)
- Invariant status changes (PASS→FAIL or FAIL→PASS)
- Per-scenario metrics for both sides (cycles, tokens, duration)
- Per-invocation cycle deltas (which specific step shifted)

Transcripts are available via `run.sh transcript <name> [scenario]` — these
show the model's reasoning between tool calls, grouped by invocation.

## Scenarios (14 total, ~14 min for the fast suite)

Each scenario is a reproducible workload exercising specific SDK subsystems:

| Scenario | Dimensions | What it stresses |
|----------|-----------|-----------------|
| transactional-integrity-via-database | state-consistency, tool-dispatch, context-management | 25 users, 40+ projects, paginated DB queries, referential integrity enforcement across 15 steps |
| paginated-api-with-latency | tool-dispatch, state-consistency, context-management | 15 users across 8 pages of pagination, 6 join dimensions, 404s and verbose nested JSON |
| work-queue-drain-under-truncation | context-management, state-consistency, agent-loop | 25-item prioritized queue with dependencies, pop/work/complete loop under tight window |
| competing-state-mutations | tool-dispatch, state-consistency | 10 rooms, 30 people, paginated listing, concurrent modification conflicts |
| approval-gated-plan-with-denials | state-consistency, agent-loop | 22-step deployment runbook with deep dependency DAG, complex approval policy |
| long-running-stateful-session | context-management, state-consistency | 25 invocations building a design artifact, KV store with pagination and versioning |
| streaming-multi-turn-assembly | streaming, tool-dispatch, context-management | 10 invocations with 7-8 parallel chunk fetches per turn, 3000+ char payloads |
| cache-sensitive-repeated-context | caching, agent-loop | 14 invocations against a large stable system prompt, 20-term reference database |
| deep-tool-chain-with-context-pressure | context-management, tool-dispatch | 14 file reads under window=7, cross-file synthesis from truncated context |
| parallel-tool-calls-with-large-outputs | tool-dispatch, context-management | 7 turns with 8-10 parallel bash reads per turn, 200+ lines each |
| interrupt-with-accumulated-state | interrupt-resume, state-consistency | Interrupted deep into a run with accumulated KV state, must resume coherently |
| multi-interrupt-resume-chain | interrupt-resume, agent-loop | 4 interrupts across a 20-step deployment, data dependencies between steps |
| nested-tool-results-as-structured-data | context-management, tool-dispatch | 18 modules analyzed with 3000+ char structured JSON per result |
| agent-as-tool-delegation | nested-agents, context-management | 14 research questions delegated to inner agent under window=8 |

All scenarios support `CHAOS=1` env var which enables per-scenario unreliability: transient errors, stale reads, conflicts, ambiguous responses, rate limiting.

### τ-bench (external benchmark, MIT license)

Multi-turn customer service tasks from Sierra Research. A simulated user (LLM-driven) makes requests, the agent navigates ~16 domain tools following complex policies. Scoring is deterministic (DB state hash comparison). Useful as an end-to-end sanity check.

```bash
bash strandly/experiment/benchmarks/tau-bench/setup.sh  # one-time
TAU_BENCH_LIMIT=10 bash strandly/experiment/run.sh --as test tau-bench
```

### Tools

Scenarios use realistic v2 tool primitives:
- **database-v2**: paginated SELECT (5 rows/page), single-row mutations, verbose JSON with metadata, optional rate limiting
- **kv-store-v2**: paginated list, versioned values, CAS semantics, optional stale-read unreliability  
- **api-mock-v2**: verbose nested JSON with headers/requestId, optional transient 500s/503s/429s
- **task-queue-v2**: priority ordering, task dependencies, stale-pop unreliability, paginated status

### Metrics captured per invocation

- Cycle count, input/output tokens, cache read/write tokens
- Context size (peak window utilization)
- Model latency (per invocation, not cumulative)
- Tool calls: name, input, output, duration, success/error, result size
- Stop reason, message count after

### Invariants (deterministic SDK-contract checks)

- **tool-pairing-intact**: every tool_use has its tool_result and vice versa
- **history-well-formed**: no tool_result precedes its tool_use
- **context-under-window**: message count stays within configured bounds
- **Scenario-specific state checks**: queue drained, capacity respected, integrity maintained, etc.

## Running

```bash
# Quick check (one scenario)
bash strandly/experiment/run.sh --as quick transactional-integrity

# Fast suite (synthetic-tool scenarios only, ~14 min)
bash strandly/experiment/run.sh --as baseline --fast

# With chaos mode (unreliability enabled)
CHAOS=1 bash strandly/experiment/run.sh --as chaos-test --fast

# Filter by dimension
bash strandly/experiment/run.sh --as test --dim context-management

# List saved runs
bash strandly/experiment/run.sh list
```

## Process

### 1. Check for existing runs

```bash
bash strandly/experiment/run.sh list
```

If a baseline already exists, skip to step 3.

### 2. Establish a baseline (if needed)

Ask the user before doing any git operations (stash, checkout). The user knows their git state better than you do.

```bash
bash strandly/experiment/run.sh --as baseline --fast
```

### 3. Run the experiment

```bash
bash strandly/experiment/run.sh --as <name> [flags]
```

Names must be unique. Pick descriptive names: `baseline`, `v2-truncation`, `retry-backoff-fix`.

Choose `--dim` based on what changed:
- `conversation-manager/` → `--dim context-management`
- `agent/tool-caller.ts`, `tools/` → `--dim tool-dispatch`
- `hooks/`, `plugins/` → run all (hooks cut across everything)
- `models/`, `retry/` → `--dim agent-loop`
- `agent/agent.ts` → run all

### 4. Interpret the comparison

The output gives you:
1. **Invariant status changes** — any mechanism that shifted (strongest signal)
2. **Per-scenario totals** — cycles, tokens, duration for both sides
3. **Per-invocation breakdown** — exactly which step shifted and by how much

Interpretation guidance:
- Lead with invariant changes (or confirm none)
- Be skeptical of small deltas (1 cycle) — likely model variance
- Relate findings to the code change — what mechanism explains the shift?
- "No observable effect" is a valid finding

### 5. Drill into transcripts

```bash
bash strandly/experiment/run.sh transcript baseline paginated
bash strandly/experiment/run.sh transcript my-change paginated
```

## Rules

- Never modify `strandly/experiment/scenarios/` unless the user explicitly asks.
- Don't modify `strandly/experiment/src/agent-factory.ts` unless the user asks to experiment with agent configuration.
- A single run in isolation has limited value — the data is most useful when compared against a prior run.
- Pick unique, descriptive run names.
- Don't treat results as pass/fail. The question is "what changed?" not "did it pass?"
- Don't do destructive git operations without user confirmation.
