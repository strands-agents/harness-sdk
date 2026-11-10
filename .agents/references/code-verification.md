# Code Verification Procedure

When writing or auditing documentation, verify every code example against the actual SDK source. Plausible-but-wrong code erodes developer trust faster than missing documentation.

The docs site lives under `site/` in this repo. All paths in this guide — including those in skill procedures that reference it — are written relative to the repo root, so they include the `site/` prefix where applicable. Run shell commands like `npm run sdk:clone` from inside `site/` (where `package.json` lives).

Use the first tier available in your environment. Fall back only when the preferred tier is unavailable.

## Tier 1: Local SDK Clones (preferred)

If you have the local clones populated by `npm run sdk:clone`, read directly from disk — it's faster than network calls and avoids API rate limits:

```
site/.build/sdk-python/src/strands/[path]
site/.build/sdk-typescript/strands-ts/src/[path]
```

If the clones aren't present, run `npm run sdk:clone` from `site/`, or fall back to Tier 2.

**Key Python modules** (under `src/strands/`):
- `agent/agent.py` — `Agent` class, constructor signature, `__call__`/`stream_async`
- `agent/agent_result.py` — `AgentResult` shape (final response, metrics, stop reason)
- `agent/conversation_manager/` — `ConversationManager`, `SlidingWindowConversationManager`, `SummarizingConversationManager`
- `agent/state.py` — `AgentState` (per-agent key/value store)
- `tools/decorator.py` — `@tool` decorator and signature inference
- `tools/tool_provider.py` — `ToolProvider` base for grouped tools
- `tools/mcp/` — MCP client/server tool integration
- `tools/structured_output/` — Structured-output tool helpers
- `hooks/registry.py` — `HookRegistry`, hook callback registration
- `hooks/events.py` — Hook event types (`BeforeInvocationEvent`, `AfterInvocationEvent`, etc.)
- `models/` — Model provider implementations (Bedrock, Anthropic, OpenAI, etc.)
- `multiagent/graph.py`, `multiagent/swarm.py`, `multiagent/a2a/` — Multi-agent orchestration
- `session/` — `SessionManager`, `FileSessionManager`, `S3SessionManager`, `RepositorySessionManager`
- `event_loop/` — Core event loop and streaming
- `telemetry/` — Tracing, metrics, OTEL integration
- `interrupt.py`, `types/interrupt.py` — Interrupt/resume primitives
- `types/exceptions.py` — Error classes
- `types/content.py`, `types/tools.py`, `types/streaming.py` — Public message/tool/stream shapes

**Key TypeScript modules** (under `strands-ts/src/`):
- `agent/` — `Agent` class, agent result, configuration
- `tools/` — `tool()` factory, tool registration, MCP tool support
- `conversation-manager/` — `ConversationManager` implementations
- `hooks/` — Hook registry and event types
- `models/` — Model provider implementations
- `multiagent/` — Graph, swarm, agent-to-agent orchestration
- `session/` — Session managers and persistence
- `plugins/`, `vended-plugins/` — Plugin system and built-in plugins
- `interventions/`, `vended-interventions/` — Intervention hooks
- `retry/` — Retry policies
- `telemetry/` — Tracing and metrics
- `errors.ts` — Error classes
- `types/` — Public type definitions (content, tools, streaming, etc.)
- `index.ts` — Public exports (canonical entry point for what's exported)

**TypeScript supporting paths:**
- `strands-ts/test/` and `strands-ts/src/__tests__/` — Unit tests (good for usage patterns)
- `strands-ts/examples/` — Runnable examples

**What to verify:**
- Import paths resolve to real modules
- Parameter names, types, and defaults match class definitions
- Referenced methods exist on the classes shown
- For pages with both languages: verify each independently

## Tier 2: GitHub API

If the local clones aren't available, fetch source through the GitHub API:

```bash
# Python SDK (now local at strands-py/src/strands/)
gh api repos/strands-agents/harness-sdk/contents/strands-py/src/strands/[path]

# TypeScript SDK (now local at strands-ts/src/)
gh api repos/strands-agents/harness-sdk/contents/strands-ts/src/[path]
```

## Tier 3: Installed Package Introspection

```bash
# Python
python -c "from strands.agent.agent import Agent; help(Agent.__init__)"

# TypeScript (check exports)
node -e "const sdk = require('@strands-agents/sdk'); console.log(Object.keys(sdk))"
```

Useful for spot-checking parameter names and types, but doesn't show internal module structure.

## Tier 4: Stop and Surface

If none of the tiers above are available, **do not ship unverified code**. Reviewers are not the verification step, and unverified blocks must not reach a PR description as a TODO list for someone else to resolve.

Instead, surface the gap in the output of the calling skill:

- **From `docs-audit`**: list each unverifiable item under `### Accuracy Issues` (e.g., "`Agent.stream_async` signature — no SDK source available to verify") and add a corresponding `### Recommended Actions` entry to acquire a verification source before re-auditing.
- **From `docs-writer`**: omit the affected code block from the draft and report the unverifiable item alongside the finished page — naming the specific class/method and the tier that failed. Do not emit a guessed example.

The expectation is that the next iteration of the skill resolves the gap, not that a reviewer takes it on.
