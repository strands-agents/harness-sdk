# τ-bench Integration

External multi-turn customer service benchmark from Sierra Research (MIT license).
Tests whether the SDK's agent loop, tool dispatch, and context management let an
agent correctly handle realistic support tasks with deterministic scoring.

## What it tests

An LLM-driven simulated user makes requests (exchanges, cancellations, lookups)
and the agent must navigate ~16 domain-specific tools, follow complex business
policies (a multi-page wiki), and make the correct state-modifying API calls.
Scoring is deterministic: the final database state is hashed and compared against
a golden replay of the ground-truth actions. Binary 1.0 or 0.0 per task.

**SDK mechanisms exercised:**
- Tool dispatch over 8-20 calls per task
- Multi-turn agent loop (2-7 turns per task)
- Tool result threading back into conversation context
- Context growth across turns (tasks reach 10-20k tokens)

**What it does NOT stress** (use bespoke scenarios for these):
- Sliding window truncation (contexts stay comfortably within limits)
- Interrupt/resume
- Prompt caching
- Parallel tool calls (τ-bench is serial by design)
- Streaming assembly
- Nested agents

## When to use

- **Regression sanity check** after broad SDK changes — if pass rate drops
  significantly, something fundamental broke.
- **End-to-end confidence** that tool dispatch + context management work under
  realistic (not synthetic) workloads.
- **Comparison baseline** — run before and after an SDK change to see if overall
  agent capability shifted.

Not useful for diagnosing *which* mechanism regressed — use `--dim` filtering
with the bespoke scenarios for that.

## Setup (one-time)

```bash
bash benchmarks/tau-bench/setup.sh
```

Creates a Python venv at `benchmarks/tau-bench/.venv/` and installs `tau-bench`
plus `boto3` (for Bedrock-based user simulation). Requires `python3` and network
access.

## Running

```bash
# Quick smoke test (1 task, ~1 minute)
bash run.sh --as my-test tau-bench

# Broader signal (10 tasks, ~10 minutes)
TAU_BENCH_LIMIT=10 bash run.sh --as my-test tau-bench

# Full suite (115 retail tasks, ~2 hours)
TAU_BENCH_LIMIT=0 bash run.sh --as full-baseline tau-bench

# Airline domain instead of retail (50 tasks available)
TAU_BENCH_ENV=airline TAU_BENCH_LIMIT=10 bash run.sh --as airline-test tau-bench
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `TAU_BENCH_LIMIT` | `5` | Tasks to run. `0` = all available (115 retail, 50 airline) |
| `TAU_BENCH_ENV` | `retail` | Domain: `retail` (exchanges, returns, cancellations) or `airline` (bookings, changes, refunds) |
| `TAU_BENCH_USER_MODEL` | `bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0` | Model for simulated user (litellm format) |
| `TAU_BENCH_USER_PROVIDER` | `bedrock` | litellm provider for user sim |

### Using a different provider for the user sim

The user simulation is powered by litellm and supports any provider it routes to:

```bash
# Anthropic API directly (needs ANTHROPIC_API_KEY)
TAU_BENCH_USER_MODEL=claude-sonnet-4-20250514 TAU_BENCH_USER_PROVIDER=anthropic

# OpenAI (needs OPENAI_API_KEY)
TAU_BENCH_USER_MODEL=gpt-4o TAU_BENCH_USER_PROVIDER=openai

# Bedrock (uses AWS credentials, no API key needed)
TAU_BENCH_USER_MODEL=bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0 TAU_BENCH_USER_PROVIDER=bedrock
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TypeScript (strandly/experiment)                        │
│                                                         │
│  scenario.ts → adapter.ts → Bridge class                │
│       │              │            │                      │
│       │              │     spawn subprocess              │
│       │              │            │                      │
│  createAgent()   tool callbacks   │  stdio JSON-RPC      │
│       │          relay to ──────→ │                      │
│       ↓          Python           ↓                      │
│  agent.invoke()              ┌─────────────────────┐    │
│       │                      │  bridge.py (Python)  │    │
│       │                      │                     │    │
│       │                      │  tau_bench.Env      │    │
│       │                      │  ├── 16 tools       │    │
│       │                      │  ├── user sim (LLM) │    │
│       │                      │  ├── data fixtures   │    │
│       │                      │  └── scoring (hash)  │    │
│       │                      └─────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

Zero business logic reimplemented. τ-bench's Python environment runs natively;
the TS side only owns the agent loop and tool dispatch.

## Task difficulty

Based on a 10-task sample (retail):

| Metric | Value |
|--------|-------|
| Pass rate | ~90% (Sonnet 4.6 via Bedrock) |
| Avg turns per task | 4-5 |
| Avg tool calls per task | 13 |
| Time per task | ~50-60 seconds |
| Range of turns | 2 (simple lookup) to 7 (complex multi-step exchange) |

The 10% failure rate represents tasks where the agent makes incorrect decisions
under complex constraints (not SDK failures). This makes it useful for detecting
regressions that degrade overall agent capability but not for diagnosing specific
SDK mechanism failures.

## Scoring

- **1.0**: Agent's tool calls produced the exact database state the ground-truth
  actions would produce, AND any required output strings appeared in the agent's
  responses to the user.
- **0.0**: Either the database state diverged OR a required output was missing.

No partial credit. No LLM judge.

## Available tasks

**Retail** (115 test tasks): order exchanges, returns, cancellations, address
changes, payment changes. Policies include return windows, item eligibility,
payment method validation, gift card balance handling.

**Airline** (50 test tasks): reservation booking, flight changes, baggage updates,
cancellations, certificate issuance. Policies include fare rules, seat availability,
cabin class restrictions, insurance refund logic.

## Relationship to bespoke scenarios

| | τ-bench | Bespoke scenarios |
|---|---|---|
| Purpose | End-to-end sanity check | Targeted mechanism stress testing |
| Difficulty source | Task complexity (policy logic) | SDK pressure (tight windows, interrupts, parallel calls) |
| Failure mode | Agent makes wrong decision | SDK corrupts state/context/pairing |
| Diagnostic value | Low (which mechanism broke?) | High (invariants point at specific code paths) |
| Run time | ~1 min/task | ~30s-2min/scenario |
| When to run | After broad changes, before shipping | After targeted changes to specific subsystems |
