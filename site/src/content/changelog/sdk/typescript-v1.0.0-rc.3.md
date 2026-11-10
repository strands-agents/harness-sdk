---
sdk: sdk
language: typescript
version: "1.0.0-rc.3"
tag: v1.0.0-rc.3
date: 2026-04-08
releaseUrl: https://github.com/strands-agents/sdk-typescript/releases/tag/v1.0.0-rc.3
packageUrl: https://www.npmjs.com/package/@strands-agents/sdk/v/1.0.0-rc.3
entries:
  - { type: feat, breaking: false, scope: examples, areas: [], title: "add browser-based agent example", pr: 384, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/384", commit: "cfc9ec2", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/cfc9ec2", author: michaelruelas }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add multiagent snapshot", pr: 756, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/756", commit: "82d4b7a", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/82d4b7a", author: JackYPCOnline }
  - { type: fix, breaking: false, scope: null, areas: [], title: "sync BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES with Python SDK", pr: 782, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/782", commit: "336c992", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/336c992", author: opieter-aws }
  - { type: fix, breaking: false, scope: null, areas: [], title: "update browser-agent example for current SDK API", pr: 792, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/792", commit: "e4112e7", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/e4112e7", author: pgrayy }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add AgentAsTool internal class", pr: 768, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/768", commit: "68eb9af", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/68eb9af", author: notowen333 }
  - { type: feat, breaking: false, scope: null, areas: [], title: "enable session manager in multiagent (P0, resume logic will be in separate PR)", pr: 764, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/764", commit: "b4cf8a6", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/b4cf8a6", author: JackYPCOnline }
  - { type: feat, breaking: false, scope: null, areas: [], title: "add mid-execution cancellation", pr: 781, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/781", commit: "58b40ae", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/58b40ae", author: notowen333 }
  - { type: fix, breaking: false, scope: null, areas: [], title: "prevent invocation lock leak when consumer breaks from stream", pr: 796, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/796", commit: "eeecbfc", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/eeecbfc", author: pgrayy }
  - { type: fix, breaking: false, scope: null, areas: [], title: "migrate MultiagentPlugin to be an interface", pr: 794, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/794", commit: "70346b0", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/70346b0", author: JackYPCOnline }
  - { type: fix, breaking: false, scope: bedrock, areas: [], title: "disable thinking when tool_choice forces tool use", pr: 798, prUrl: "https://github.com/strands-agents/sdk-typescript/pull/798", commit: "afb3912", commitUrl: "https://github.com/strands-agents/sdk-typescript/commit/afb3912", author: pgrayy }
newContributors:
  - { login: michaelruelas, pr: 384 }
  - { login: opieter-aws, pr: 782 }
---

###  Features

#### Mid-Execution Cancellation — [PR#781](https://github.com/strands-agents/sdk-typescript/pull/781)

The SDK now supports cooperative cancellation of running agent invocations. Callers can stop an agent mid-execution via `agent.cancel()`, `AbortSignal.timeout()`, or any external `AbortSignal` (e.g., from an HTTP framework). Cancellation is checked between model stream events and before each tool execution, and running tools are never forcibly interrupted — they complete unless the tool itself checks the cancellation signal.

```typescript
import { Agent } from '@strands-agents/sdk';

const agent = new Agent({ model, tools });

// Cancel after 5 seconds
setTimeout(() => agent.cancel(), 5000);
const result = await agent.invoke('Do something long');
console.log(result.stopReason); // 'cancelled'

// Or use AbortSignal.timeout for declarative timeouts
const result = await agent.invoke('Hello', {
  cancellationSignal: AbortSignal.timeout(5000),
});

// Framework-driven cancellation (e.g., Express)
app.post('/chat', async (req, res) => {
  const result = await agent.invoke(req.body.message, {
    cancellationSignal: req.signal,
  });
  res.json(result);
});
```

Tools can participate in cooperative cancellation by checking `context.agent.cancellationSignal`:

```typescript
callback: async ({ url }, context) => {
  // Signal forwarding — fetch aborts if agent is cancelled
  const res = await fetch(url, { signal: context.agent.cancellationSignal });
  return res.text();
};
```

⚠️ **Type change:** `StopReason` union now includes `'cancelled'`.

#### Agent-as-Tool — [PR#768](https://github.com/strands-agents/sdk-typescript/pull/768)

Agents can now be used as tools for other agents via `agent.asTool()` or by passing agents directly in the `tools` array (auto-wrapped). This enables hierarchical multi-agent architectures where a parent agent delegates subtasks to specialized child agents. The `preserveContext` option controls whether the sub-agent retains conversation history across invocations.

```typescript
const researcher = new Agent({
  name: 'researcher',
  description: 'Finds information on a topic',
  tools: [searchTool],
  printer: false,
});

// Pass agents directly in tools array (auto-wrapped)
const writer = new Agent({
  tools: [researcher],
});
await writer.invoke('Write an article about quantum computing');

// Or wrap explicitly with options
const tool = researcher.asTool({ preserveContext: true });
```

#### Multi-Agent Session Persistence — [PR#764](https://github.com/strands-agents/sdk-typescript/pull/764)

`SessionManager` now implements `MultiAgentPlugin`, enabling Graph and Swarm orchestrators to automatically save and restore execution state. After each orchestrator invocation, the multi-agent state (node statuses, results, steps, app state) is persisted. On the next invocation, the snapshot is restored before the first node executes.

```typescript
import { SessionManager, FileStorage, Graph } from '@strands-agents/sdk';

const session = new SessionManager({
  sessionId: 'my-session',
  storage: { snapshot: new FileStorage() },
});

const graph = new Graph({
  id: 'my-graph',
  nodes: [researcher, writer, editor],
  edges: [['researcher', 'writer'], ['writer', 'editor']],
  plugins: [session],
});

// First invocation — snapshot saved automatically
await graph.invoke('Write about AI');

// Second invocation — state restored from snapshot
await graph.invoke('Continue');
```

Scope isolation between agent and multi-agent snapshots is maintained. A shared `SessionManager` across multiple orchestrators restores each one independently.

#### Multi-Agent Snapshot Primitives — [PR#756](https://github.com/strands-agents/sdk-typescript/pull/756)

Adds internal snapshot take/load support for multi-agent orchestrators (Graph and Swarm). `takeSnapshot()` captures orchestrator ID and serialized execution state; `loadSnapshot()` validates scope, schema version, and orchestrator ID before restoring state. Also adds scope validation to agent `loadSnapshot` — passing a multi-agent snapshot to the agent loader now throws instead of silently no-oping.

### Bug Fixes

- **Invocation lock leak on stream break** — [PR#796](https://github.com/strands-agents/sdk-typescript/pull/796): When a consumer broke out of `for-await-of` on `agent.stream()`, the runtime called `.return()` on the generator. The `finally` block tried to drain remaining events via `yield`, but with no consumer to resume the generator, it suspended permanently. The lock disposable never ran, leaving `_isInvoking` stuck at `true` and causing `ConcurrentInvocationError` on any subsequent call. Drain events are now only yielded when the consumer may still be iterating.

- **Bedrock thinking + forced tool_choice conflict** — [PR#798](https://github.com/strands-agents/sdk-typescript/pull/798): When using `structuredOutputSchema` with extended thinking enabled, the agent hit a Bedrock API error: "Thinking may not be enabled when tool_choice forces tool use." The SDK now strips the `thinking` key from `additionalRequestFields` when `toolChoice` forces tool use (`any` or `tool` variants), preserving thinking for `auto` and unset tool choice.

- **Bedrock context window overflow detection** — [PR#782](https://github.com/strands-agents/sdk-typescript/pull/782): Synced `BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES` with the Python SDK to include the `'prompt is too long'` error pattern, ensuring consistent overflow detection across both SDKs.
