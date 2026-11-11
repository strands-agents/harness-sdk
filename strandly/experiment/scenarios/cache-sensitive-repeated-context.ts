import { createAgent } from '../src/agent-factory.js'
import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

export default scenario({
  description: 'Agent makes 14 successive invocations against a large stable system prompt and tools, where each invocation is a short question-and-lookup with verbose responses (~2000+ chars per lookup). Includes a second tool (search_references) that forces cross-lookups between terms. Designed to maximize prompt-cache hit opportunity — the system prompt and tool definitions are identical across all calls, so cacheReadTokens should dominate after the first invocation.',
  stresses: 'Prompt caching behavior across multiple invocations sharing the same system prompt and tool definitions. The system prompt is deliberately large (~3000+ tokens of reference material) so that caching it meaningfully reduces input cost. Tool responses are verbose (full definitions, examples, cross-references, version history — 2000+ chars each) creating significant per-turn content that gets truncated while the cached prefix remains stable. After the first invocation primes the cache, subsequent invocations should show high cacheReadTokens and lower fresh inputTokens. An SDK change that breaks cache continuity (e.g. reordering messages, mutating the system prompt, or resending tool definitions differently) shows up as cacheReadTokens dropping to zero while inputTokens spikes. With CHAOS=1, lookups occasionally return CACHE_MISS errors requiring retry.',
  dimensions: ['caching', 'agent-loop'],
  run,
})

async function run(profiler: ProfilerObserver) {
  let lookupsPerformed = 0
  let referenceSearches = 0
  let cacheMissErrors = 0

  const chaosEnabled = process.env.CHAOS === '1'

  const db: Record<string, { definition: string; examples: string[]; related: string[]; crossReferences: string[]; versionHistory: string[]; notes: string }> = {
    'sliding-window': {
      definition: 'A conversation manager that keeps only the N most recent messages, dropping older ones while preserving tool_use/tool_result pairs. The window size is configurable and determines the maximum number of messages retained after each reduction pass. When triggered, it walks backward from the most recent message, keeping complete pairs and dropping unpaired orphans from the head.',
      examples: [
        'new SlidingWindowConversationManager({ windowSize: 10 }) — keeps last 10 messages',
        'agent.conversationManager.reduce(messages) — manually triggers reduction',
        'Configuring via agent options: createAgent({ conversationManager: { type: "sliding-window", windowSize: 20 } })',
      ],
      related: ['truncation', 'context-overflow', 'message-pairing', 'proactive-compression'],
      crossReferences: ['Referenced by: truncation (as primary implementation)', 'Referenced by: context-overflow (as recovery mechanism)', 'Referenced by: proactive-compression (as underlying strategy)'],
      versionHistory: ['v0.1.0: Initial implementation with basic window', 'v0.3.0: Added tool-pair preservation during truncation', 'v0.5.0: Added proactive triggering via BeforeModelCallEvent', 'v0.7.0: Configurable threshold ratio for proactive compression'],
      notes: 'The sliding window is the default conversation manager. It prioritizes recency over completeness — older context is permanently lost unless the caller implements external memory.',
    },
    'truncation': {
      definition: 'The process of removing messages from conversation history to fit within context window limits. Truncation can be proactive (triggered before a model call when projected tokens exceed a threshold) or reactive (triggered after a ContextWindowOverflowError). The conversation manager implements the truncation strategy, and the SDK guarantees that tool_use/tool_result pairs are never split during truncation.',
      examples: [
        'Proactive: manager detects projected tokens > threshold and calls reduce() before model call',
        'Reactive: model returns ContextWindowOverflowError, SDK catches it and calls reduce() then retries',
        'Manual: agent.conversationManager.reduce(agent.messages) — forces truncation regardless of token count',
      ],
      related: ['sliding-window', 'summarization', 'context-overflow', 'proactive-compression'],
      crossReferences: ['Referenced by: sliding-window (as the operation it performs)', 'Referenced by: tool-pairing (as the operation that must preserve pairs)', 'Referenced by: context-overflow (as the recovery action)'],
      versionHistory: ['v0.1.0: Basic head-drop truncation', 'v0.3.0: Pair-preserving truncation', 'v0.4.0: Proactive truncation support', 'v0.6.0: Metrics tracking for truncation events'],
      notes: 'Truncation is irreversible within a single agent instance. Once messages are dropped, they cannot be recovered. Design patterns that need full history should use external storage.',
    },
    'tool-pairing': {
      definition: 'The invariant that every tool_use block in the message history has a corresponding tool_result and vice versa. This is critical for model correctness — models expect to see the result of every tool call they made, and a dangling tool_use without its result causes undefined behavior (hallucinated results, refusals, or loops). The SDK enforces this during truncation by treating use/result as atomic units.',
      examples: [
        'Valid: [{tool_use: id=abc}, {tool_result: id=abc}] — paired correctly',
        'Invalid: [{tool_use: id=abc}] — dangling use, result was truncated',
        'Invalid: [{tool_result: id=xyz}] — orphan result, use was truncated',
        'Validated by: toolPairingIntact(agent.messages) invariant check',
      ],
      related: ['tool-dispatch', 'truncation', 'message-integrity', 'sliding-window'],
      crossReferences: ['Referenced by: truncation (as the constraint it must satisfy)', 'Referenced by: sliding-window (as the pair-preservation guarantee)', 'Referenced by: history-well-formed (as a subset check)'],
      versionHistory: ['v0.1.0: No enforcement — pairs could be split', 'v0.3.0: Pair-preserving truncation implemented', 'v0.5.0: Invariant check added to test harness', 'v0.8.0: Extended to multi-tool-use blocks (parallel tool calls)'],
      notes: 'Parallel tool calls produce multiple tool_use blocks in a single assistant message, each needing its own tool_result in the next user message. The pairing check handles this correctly.',
    },
    'context-overflow': {
      definition: 'When the total token count of messages exceeds the model context window limit, triggering a ContextWindowOverflowError. This is a hard failure from the model provider — the request was too large to process. The SDK catches this error and delegates to the conversation manager for reactive reduction, then retries the model call. If reduction cannot bring the context below the limit, the error propagates to the caller.',
      examples: [
        'Error: ContextWindowOverflowError { inputTokens: 128500, maxTokens: 128000 }',
        'Recovery: catch overflow -> manager.reduce(messages) -> retry model call',
        'Prevention: proactive compression triggers at 80% of limit (configurable)',
      ],
      related: ['truncation', 'sliding-window', 'proactive-compression', 'model-limits'],
      crossReferences: ['Referenced by: truncation (as the trigger for reactive truncation)', 'Referenced by: proactive-compression (as the failure it prevents)', 'Referenced by: agent-loop (as a retryable error)'],
      versionHistory: ['v0.1.0: Error propagated directly to caller', 'v0.2.0: Automatic retry after reduction', 'v0.4.0: Proactive prevention added', 'v0.6.0: Configurable threshold ratio', 'v0.8.0: Metrics tracking for overflow events'],
      notes: 'Context overflow should be rare in well-configured agents. If it happens frequently, increase the window size or enable proactive compression with a lower threshold.',
    },
    'proactive-compression': {
      definition: 'Reducing context before hitting the model limit, triggered when projected input tokens exceed a configurable threshold ratio (default 0.8 of max context). This fires during BeforeModelCallEvent — the conversation manager estimates the token count of the pending request and, if it exceeds the threshold, runs reduce() before the model call proceeds. This avoids the latency penalty of a failed model call followed by retry.',
      examples: [
        'Threshold config: { proactiveThreshold: 0.75 } — triggers at 75% of context limit',
        'Hook: BeforeModelCallEvent -> if projectedTokens > threshold -> reduce()',
        'Metrics: agent.metrics.proactiveReductions tracks how often this fires',
      ],
      related: ['context-overflow', 'sliding-window', 'BeforeModelCallEvent', 'summarization'],
      crossReferences: ['Referenced by: sliding-window (as the proactive trigger mechanism)', 'Referenced by: context-overflow (as the preventive measure)', 'Referenced by: hooks (as a BeforeModelCallEvent consumer)'],
      versionHistory: ['v0.4.0: Initial implementation', 'v0.6.0: Configurable threshold', 'v0.7.0: Token estimation improvements', 'v0.9.0: Support for summarizing managers'],
      notes: 'Proactive compression trades a small amount of context retention for reliable operation. Without it, agents processing large tool outputs can hit overflow on every turn.',
    },
    'interrupt': {
      definition: 'A mechanism to pause agent execution mid-invocation, preserving state for later resumption via InterruptResponseContent. Interrupts are set by hooks on BeforeToolCallEvent — when a hook sets event.interrupt, the agent stops the loop, records the pending tool calls, and returns with stopReason="interrupt". The caller can inspect the interrupts array, decide how to proceed, and resume with responses.',
      examples: [
        'Hook: agent.addHook("BeforeToolCallEvent", (e) => { if (needsApproval(e.tool)) e.interrupt = { reason: "approval_needed" } })',
        'Caller: const result = await agent.invoke(msg) // result.stopReason === "interrupt"',
        'Resume: await agent.invoke(InterruptResponseContent.approved(result.interrupts[0]))',
      ],
      related: ['resume', 'BeforeToolCallEvent', 'state-preservation', 'hooks'],
      crossReferences: ['Referenced by: resume (as the operation that continues after interrupt)', 'Referenced by: hooks (as a BeforeToolCallEvent capability)', 'Referenced by: agent-loop (as a stop condition)'],
      versionHistory: ['v0.5.0: Initial interrupt mechanism', 'v0.6.0: Multi-interrupt support (parallel tool calls)', 'v0.7.0: InterruptResponseContent helpers', 'v0.9.0: Interrupt state serialization for persistence'],
      notes: 'Interrupts are the primary mechanism for human-in-the-loop workflows. They allow the agent to propose actions and wait for approval before executing.',
    },
    'resume': {
      definition: 'Continuing an interrupted agent invocation by passing InterruptResponseContent to a subsequent invoke() call. Resume reconstructs the agent state at the point of interruption — pending tool calls, accumulated messages, and cycle count — then continues the loop from where it paused. The caller provides responses for each interrupt (approved, denied, or modified).',
      examples: [
        'Resume approved: agent.invoke(InterruptResponseContent.approved(interrupt))',
        'Resume denied: agent.invoke(InterruptResponseContent.denied(interrupt, "too risky"))',
        'Resume modified: agent.invoke(InterruptResponseContent.modified(interrupt, { param: "new_value" }))',
      ],
      related: ['interrupt', 'history-continuity', 'state-preservation', 'agent-loop'],
      crossReferences: ['Referenced by: interrupt (as the continuation mechanism)', 'Referenced by: history-continuity (as a state reconstruction operation)', 'Referenced by: agent-loop (as an alternative entry point to invoke)'],
      versionHistory: ['v0.5.0: Basic resume support', 'v0.6.0: Multi-interrupt resume', 'v0.7.0: Modified responses (tool input override)', 'v0.9.0: Resumable from serialized state'],
      notes: 'Resume must see the same message history that was present at interrupt time. If the caller modifies messages between interrupt and resume, behavior is undefined.',
    },
    'plugin': {
      definition: 'An object implementing the Plugin interface that can hook into agent lifecycle events via initAgent(). Plugins are the primary extension mechanism — they receive the agent instance during initialization and can register hooks, modify configuration, add tools, or wrap behavior. Multiple plugins can be composed, with their hooks firing in registration order.',
      examples: [
        'interface Plugin { name: string; initAgent(agent: Agent): void }',
        'class LoggingPlugin implements Plugin { initAgent(agent) { agent.addHook("AfterModelCallEvent", (e) => log(e)) } }',
        'Usage: createAgent({ plugins: [new LoggingPlugin(), new MetricsPlugin()] })',
      ],
      related: ['hooks', 'initAgent', 'BeforeModelCallEvent', 'conversation-manager'],
      crossReferences: ['Referenced by: hooks (as the registration mechanism)', 'Referenced by: conversation-manager (as a plugin itself)', 'Referenced by: agent-loop (as the extension point)'],
      versionHistory: ['v0.2.0: Plugin interface introduced', 'v0.4.0: Plugin ordering guarantees', 'v0.6.0: Plugin lifecycle (destroy/cleanup)', 'v0.8.0: Plugin metadata and capability discovery'],
      notes: 'The conversation manager is itself a plugin — it registers hooks for proactive compression and overflow recovery. This means all conversation management behavior is removable/replaceable.',
    },
    'hooks': {
      definition: 'Typed event callbacks registered on an agent via addHook(). Fire in registration order for before-events, reverse order for after-events. Hook types include BeforeModelCallEvent, AfterModelCallEvent, BeforeToolCallEvent, AfterToolCallEvent, and more. Hooks can modify events (e.g. adding headers), set interrupts, or perform side effects (logging, metrics).',
      examples: [
        'agent.addHook("BeforeModelCallEvent", (event) => { event.headers["x-custom"] = "value" })',
        'agent.addHook("AfterToolCallEvent", (event) => { metrics.record(event.tool, event.duration) })',
        'Order: [pluginA.before, pluginB.before] -> model call -> [pluginB.after, pluginA.after]',
      ],
      related: ['plugin', 'BeforeModelCallEvent', 'AfterToolCallEvent', 'interrupt'],
      crossReferences: ['Referenced by: plugin (as the capability plugins register)', 'Referenced by: interrupt (as the mechanism that sets interrupts)', 'Referenced by: proactive-compression (as the trigger event)'],
      versionHistory: ['v0.2.0: Basic hook system', 'v0.3.0: Typed events', 'v0.4.0: Ordering guarantees (FIFO before, LIFO after)', 'v0.6.0: Async hook support', 'v0.8.0: Hook removal and one-shot hooks'],
      notes: 'The FIFO/LIFO ordering ensures that plugins wrapping behavior (e.g. timing) see consistent before/after boundaries even when multiple plugins are composed.',
    },
    'agent-as-tool': {
      definition: 'Using one Agent instance as a tool for another via asTool(), serializing the inner agent result into the outer context. This enables hierarchical agent architectures where a coordinator delegates subtasks to specialized agents. The inner agent runs its full loop (potentially multiple cycles) and returns a single tool_result to the outer agent.',
      examples: [
        'const researcher = createAgent({ tools: [webSearch] })',
        'const coordinator = createAgent({ tools: [researcher.asTool("research", "Research a topic deeply")] })',
        'Context impact: inner agent conversation is NOT added to outer — only the final result string',
      ],
      related: ['nested-agents', 'tool-dispatch', 'context-management', 'multi-agent'],
      crossReferences: ['Referenced by: tool-dispatch (as a tool type)', 'Referenced by: context-management (as a context isolation boundary)', 'Referenced by: nested-agents (as the implementation mechanism)'],
      versionHistory: ['v0.3.0: Initial asTool() implementation', 'v0.5.0: Configurable result serialization', 'v0.7.0: Streaming passthrough for inner agent', 'v0.9.0: Shared memory between inner/outer agents'],
      notes: 'asTool() creates a context isolation boundary — the inner agent has its own message history and context window. This prevents a chatty inner agent from overflowing the outer context.',
    },
    'summarization': {
      definition: 'A conversation management strategy that replaces evicted messages with a model-generated summary rather than simply dropping them. The SummarizingConversationManager calls the model with the messages to be evicted and a summarization prompt, then inserts the summary as a system message at the head of the retained conversation. More expensive than sliding-window but preserves semantic content.',
      examples: [
        'new SummarizingConversationManager({ retainCount: 10, summaryModel: "fast" })',
        'Summary placement: [system_prompt, summary_of_evicted, ...retained_messages]',
        'Cost tradeoff: 1 extra model call per reduction vs. losing all evicted context',
      ],
      related: ['sliding-window', 'truncation', 'proactive-compression', 'context-overflow'],
      crossReferences: ['Referenced by: sliding-window (as an alternative strategy)', 'Referenced by: truncation (as a lossy-but-semantic variant)', 'Referenced by: proactive-compression (as a compatible strategy)'],
      versionHistory: ['v0.6.0: Initial implementation', 'v0.7.0: Configurable summary model', 'v0.8.0: Incremental summarization (summary-of-summaries)', 'v0.9.0: Summary quality metrics'],
      notes: 'Summarization adds latency and cost but dramatically improves agent performance on tasks requiring long-range memory. Best for multi-turn conversations where early context matters.',
    },
    'model-limits': {
      definition: 'The constraints imposed by the underlying model provider: maximum input tokens, maximum output tokens, supported features (tool use, vision, streaming), and rate limits. The SDK queries these via the model provider interface and uses them to configure proactive compression thresholds, validate tool definitions, and handle rate-limit errors with exponential backoff.',
      examples: [
        'Claude Sonnet: { maxInputTokens: 200000, maxOutputTokens: 8192, supportsTools: true }',
        'Validation: SDK rejects tool definitions exceeding provider schema limits',
        'Backoff: 429 responses trigger exponential retry with jitter',
      ],
      related: ['context-overflow', 'proactive-compression', 'rate-limiting', 'provider-interface'],
      crossReferences: ['Referenced by: context-overflow (as the hard constraint)', 'Referenced by: proactive-compression (as the basis for threshold calculation)', 'Referenced by: agent-loop (as retry configuration)'],
      versionHistory: ['v0.1.0: Hardcoded limits', 'v0.3.0: Provider-reported limits', 'v0.5.0: Dynamic limit discovery', 'v0.8.0: Model capability negotiation'],
      notes: 'Different model versions within the same family may have different limits. Always use the provider-reported limits rather than hardcoding assumptions.',
    },
    'message-integrity': {
      definition: 'The set of structural invariants that must hold for a message history to be valid input to a model: alternating user/assistant roles, no consecutive same-role messages, tool_results following their tool_uses, no empty content blocks, and correct block typing. The SDK validates these before each model call and the invariant checks verify them post-hoc.',
      examples: [
        'Valid sequence: [user, assistant(tool_use), user(tool_result), assistant(text)]',
        'Invalid: [assistant, assistant] — consecutive same-role messages',
        'Invalid: [user(tool_result)] — tool_result without preceding tool_use',
        'Check: historyWellFormed(agent.messages) validates ordering invariants',
      ],
      related: ['tool-pairing', 'history-well-formed', 'truncation', 'sliding-window'],
      crossReferences: ['Referenced by: tool-pairing (as a subset of integrity checks)', 'Referenced by: truncation (as the constraint truncation must maintain)', 'Referenced by: agent-loop (as pre-call validation)'],
      versionHistory: ['v0.1.0: Basic role alternation check', 'v0.3.0: Tool pairing validation', 'v0.5.0: Content block type validation', 'v0.7.0: Comprehensive pre-call integrity check'],
      notes: 'Message integrity violations are always SDK bugs — the model cannot produce an invalid history on its own. They indicate a truncation, resume, or message-manipulation fault.',
    },
    'nested-agents': {
      definition: 'An architectural pattern where multiple Agent instances collaborate on a task, typically via agent-as-tool or explicit orchestration. Each nested agent has its own conversation history, tools, and context window, providing isolation. The pattern enables decomposition of complex tasks into specialized sub-agents while keeping each individual context manageable.',
      examples: [
        'Coordinator pattern: outer agent routes to specialized inner agents via asTool()',
        'Pipeline pattern: agent A produces output -> passed as input to agent B',
        'Consensus pattern: multiple agents answer independently, coordinator synthesizes',
      ],
      related: ['agent-as-tool', 'multi-agent', 'context-management', 'tool-dispatch'],
      crossReferences: ['Referenced by: agent-as-tool (as the underlying mechanism)', 'Referenced by: context-management (as the isolation strategy)', 'Referenced by: multi-agent (as one implementation approach)'],
      versionHistory: ['v0.3.0: asTool() enables basic nesting', 'v0.5.0: Shared tool registry across nested agents', 'v0.7.0: Inter-agent communication events', 'v0.9.0: Parallel nested agent execution'],
      notes: 'Nesting depth is limited by available compute and latency budgets. Each level adds at minimum one model call. Deep nesting (>3 levels) is usually a design smell.',
    },
    'tool-dispatch': {
      definition: 'When the model emits tool_use blocks, the ToolCaller resolves each tool from the ToolRegistry, validates inputs against the tool schema, executes the callback (possibly in parallel for multiple tool_use blocks in a single response), collects results, and adds tool_result blocks to the message history. Failed tool executions produce error tool_results rather than throwing.',
      examples: [
        'Parallel: model emits [tool_use A, tool_use B] -> SDK runs A and B concurrently',
        'Validation: input fails schema -> tool_result with error, no callback invoked',
        'Timeout: tool exceeds configured timeout -> tool_result with timeout error',
      ],
      related: ['tool-pairing', 'agent-loop', 'ToolRegistry', 'parallel-execution'],
      crossReferences: ['Referenced by: tool-pairing (as the producer of tool_use/tool_result pairs)', 'Referenced by: agent-loop (as the tool execution phase)', 'Referenced by: agent-as-tool (as the mechanism that invokes nested agents)'],
      versionHistory: ['v0.1.0: Sequential tool execution', 'v0.2.0: Parallel execution for multiple tool_use blocks', 'v0.4.0: Schema validation before execution', 'v0.6.0: Configurable timeouts', 'v0.8.0: Tool execution metrics'],
      notes: 'Parallel dispatch is the default for multiple tool_use blocks in a single response. Sequential dispatch can be forced via configuration for tools with ordering dependencies.',
    },
    'multi-agent': {
      definition: 'Systems composed of multiple Agent instances working together, either via nested-agent patterns (agent-as-tool) or external orchestration (a non-agent coordinator dispatching work). Multi-agent systems trade simplicity for capability — they can handle tasks too complex for a single agent context window or tool set, but add coordination overhead and failure modes.',
      examples: [
        'Hub-spoke: coordinator agent delegates to N specialist agents',
        'Assembly line: agents process sequentially, each adding to a shared artifact',
        'Debate: agents argue positions, judge agent decides outcome',
      ],
      related: ['nested-agents', 'agent-as-tool', 'context-management', 'orchestration'],
      crossReferences: ['Referenced by: nested-agents (as one implementation pattern)', 'Referenced by: agent-as-tool (as the primary integration mechanism)', 'Referenced by: tool-dispatch (as the execution layer for agent-tools)'],
      versionHistory: ['v0.3.0: Basic multi-agent via asTool()', 'v0.5.0: Shared state mechanisms', 'v0.7.0: Agent communication primitives', 'v0.9.0: Multi-agent observability and tracing'],
      notes: 'Multi-agent systems are powerful but hard to debug. Ensure each agent has clear responsibility boundaries and that the coordination protocol is well-defined.',
    },
    'rate-limiting': {
      definition: 'Handling model provider rate limits (HTTP 429 responses) with exponential backoff and jitter. The SDK automatically retries rate-limited requests up to a configurable maximum, with increasing delays between attempts. Concurrent requests from parallel tool executions share a rate limiter to avoid thundering herd problems.',
      examples: [
        'Default: 3 retries with exponential backoff (1s, 2s, 4s) + random jitter',
        'Config: { rateLimitRetries: 5, initialBackoff: 500 } — custom retry settings',
        'Shared limiter: parallel tool calls using agent-as-tool share the parent rate limiter',
      ],
      related: ['model-limits', 'agent-loop', 'error-handling', 'parallel-execution'],
      crossReferences: ['Referenced by: model-limits (as the enforcement mechanism)', 'Referenced by: agent-loop (as a retryable error handler)', 'Referenced by: multi-agent (as a shared resource concern)'],
      versionHistory: ['v0.2.0: Basic retry on 429', 'v0.4.0: Exponential backoff with jitter', 'v0.6.0: Shared rate limiter', 'v0.8.0: Per-model rate limit configuration'],
      notes: 'Rate limiting is most problematic in multi-agent systems where concurrent agents compete for the same model endpoint. Design systems with rate budgets per agent.',
    },
    'BeforeModelCallEvent': {
      definition: 'A hook event fired before each model API call. Allows plugins to inspect and modify the request (messages, tools, system prompt, parameters) before it reaches the provider. The conversation manager uses this event for proactive compression. Hooks can also cancel the call by throwing, which aborts the current cycle.',
      examples: [
        'agent.addHook("BeforeModelCallEvent", (e) => { e.messages = filterSensitive(e.messages) })',
        'Proactive compression: if (estimateTokens(e.messages) > threshold) reduce(e.messages)',
        'Logging: console.log(`Model call #${e.cycleIndex} with ${e.messages.length} messages`)',
      ],
      related: ['hooks', 'proactive-compression', 'plugin', 'AfterModelCallEvent'],
      crossReferences: ['Referenced by: proactive-compression (as the trigger event)', 'Referenced by: hooks (as a hook type)', 'Referenced by: plugin (as a common hook target)'],
      versionHistory: ['v0.2.0: Event introduced', 'v0.4.0: Mutable event properties', 'v0.6.0: Cycle index tracking', 'v0.8.0: Token estimation utilities on event'],
      notes: 'BeforeModelCallEvent fires once per cycle, potentially multiple times per invocation. Do not confuse with per-invocation setup — use the invoke start event for that.',
    },
    'AfterToolCallEvent': {
      definition: 'A hook event fired after each tool execution completes (or fails). Contains the tool name, input, output (or error), execution duration, and the tool_use ID. Useful for metrics collection, output validation, result transformation, and audit logging. Fires once per tool_use block, even for parallel executions.',
      examples: [
        'agent.addHook("AfterToolCallEvent", (e) => { if (e.error) alertOnFailure(e) })',
        'Metrics: durations.push({ tool: e.toolName, ms: e.duration, success: !e.error })',
        'Transform: e.result = sanitize(e.result) — modify result before it enters history',
      ],
      related: ['hooks', 'tool-dispatch', 'plugin', 'BeforeToolCallEvent'],
      crossReferences: ['Referenced by: hooks (as a hook type)', 'Referenced by: tool-dispatch (as the post-execution event)', 'Referenced by: plugin (as a common hook target for metrics)'],
      versionHistory: ['v0.2.0: Event introduced', 'v0.4.0: Duration tracking', 'v0.6.0: Result modification support', 'v0.8.0: Parallel execution index'],
      notes: 'AfterToolCallEvent fires after the tool callback returns but before the result is added to message history. Modifications to e.result are reflected in the history.',
    },
    'state-preservation': {
      definition: 'Maintaining agent state across interrupt/resume boundaries and across serialization/deserialization. State includes the message history, pending tool calls, cycle count, accumulated metrics, and any plugin-managed state. The SDK provides serialization helpers that capture a snapshot of agent state for persistence (e.g. to a database between requests in a serverless environment).',
      examples: [
        'Interrupt state: { messages, pendingTools, cycleCount, metrics, pluginState }',
        'Serialize: const snapshot = agent.serialize() — captures full state',
        'Restore: const agent = Agent.deserialize(snapshot) — reconstructs from snapshot',
      ],
      related: ['interrupt', 'resume', 'history-continuity', 'serverless'],
      crossReferences: ['Referenced by: interrupt (as the state captured at pause)', 'Referenced by: resume (as the state restored at continuation)', 'Referenced by: nested-agents (as per-agent isolated state)'],
      versionHistory: ['v0.5.0: Basic state capture for interrupt', 'v0.7.0: Full serialization support', 'v0.8.0: Plugin state serialization protocol', 'v0.9.0: Incremental state diffs for efficiency'],
      notes: 'State preservation is essential for serverless deployments where the agent process may not persist between requests. Design plugins to implement the serialization protocol.',
    },
  }

  const lookup = tool({
    name: 'lookup_reference',
    description: 'Look up a term in the reference database. Returns its full definition, usage examples, related terms, cross-references to other terms that reference it, version history, and implementation notes.',
    inputSchema: z.object({ term: z.string() }),
    callback: (input) => {
      lookupsPerformed++

      // CHAOS: ~15% chance of returning a cache miss error
      if (chaosEnabled && Math.random() < 0.15) {
        cacheMissErrors++
        return JSON.stringify({
          error: 'CACHE_MISS',
          message: 'Rebuilding index, retry in a moment. The reference database cache has been invalidated and is being reconstructed. Please retry your lookup.',
          term: input.term,
          retryable: true,
        })
      }

      const entry = db[input.term.toLowerCase()]
      if (!entry) return JSON.stringify({ error: `term "${input.term}" not found`, available: Object.keys(db) })
      return JSON.stringify({
        term: input.term,
        definition: entry.definition,
        examples: entry.examples,
        related: entry.related,
        crossReferences: entry.crossReferences,
        versionHistory: entry.versionHistory,
        notes: entry.notes,
      })
    },
  })

  const searchReferences = tool({
    name: 'search_references',
    description: 'Search for which terms in the reference database reference a given term. Returns all terms whose crossReferences mention the searched term, along with the context of how they reference it. Useful for understanding how concepts connect.',
    inputSchema: z.object({ term: z.string() }),
    callback: (input) => {
      referenceSearches++

      // CHAOS: ~10% chance of cache miss
      if (chaosEnabled && Math.random() < 0.1) {
        cacheMissErrors++
        return JSON.stringify({
          error: 'CACHE_MISS',
          message: 'Rebuilding index, retry in a moment. Cross-reference index invalidated.',
          term: input.term,
          retryable: true,
        })
      }

      const searchTerm = input.term.toLowerCase()
      const results: Array<{ term: string; reference: string; relationship: string }> = []

      for (const [key, entry] of Object.entries(db)) {
        // Check if this term's related or crossReferences mention the searched term
        if (entry.related.some(r => r.toLowerCase().includes(searchTerm))) {
          results.push({
            term: key,
            reference: `Listed in related terms`,
            relationship: entry.crossReferences.find(cr => cr.toLowerCase().includes(searchTerm)) || 'indirect reference via related terms',
          })
        }
        if (entry.crossReferences.some(cr => cr.toLowerCase().includes(searchTerm))) {
          if (!results.find(r => r.term === key)) {
            results.push({
              term: key,
              reference: `Explicit cross-reference`,
              relationship: entry.crossReferences.find(cr => cr.toLowerCase().includes(searchTerm)) || '',
            })
          }
        }
      }

      if (results.length === 0) {
        return JSON.stringify({ term: input.term, referencedBy: [], message: `No terms in the database reference "${input.term}".` })
      }

      return JSON.stringify({
        term: input.term,
        referencedBy: results,
        totalReferences: results.length,
      })
    },
  })

  // Large system prompt to maximize cache opportunity.
  const systemPrompt = `You are a technical reference assistant for the Strands Agents SDK. You help developers understand SDK concepts by looking up terms and explaining relationships between them. Use the available tools to provide precise, well-sourced answers.

## Reference Context (SDK Architecture Overview)

The Strands Agents SDK is built around a central Agent class that orchestrates model calls, tool dispatch, and conversation management in a loop. The key subsystems are:

1. AGENT LOOP: The core invoke/stream cycle. The agent sends messages to the model, receives responses (which may include tool_use blocks), dispatches tools, collects results, and loops until the model returns endTurn or the turn budget is exhausted. Each iteration is a "cycle." The loop handles retries on context overflow by delegating to the conversation manager. The cycle count is tracked per-invocation and accumulates in metrics.

2. CONVERSATION MANAGEMENT: Pluggable strategy for keeping message history within the model's context window. The SlidingWindowConversationManager drops oldest messages while preserving tool_use/tool_result pairs. The SummarizingConversationManager calls the model to produce a summary of evicted messages. Both implement a reduce() method called either proactively (before model call, when projected tokens exceed a threshold) or reactively (after a ContextWindowOverflowError). The manager itself is a Plugin.

3. TOOL DISPATCH: When the model emits tool_use blocks, the ToolCaller resolves each tool from the ToolRegistry, validates inputs against the Zod schema, executes it (possibly in parallel for multiple tool_use blocks), and adds tool_result blocks to the message history. Tools can be functions, other agents (via asTool()), or MCP server tools. Execution respects configurable timeouts.

4. HOOKS AND PLUGINS: Typed events fire at each stage of the loop. Plugins register hooks via initAgent(). Hook order matters: before-events fire in registration order (FIFO), after-events fire in reverse order (LIFO). The conversation manager itself is a plugin that hooks BeforeModelCallEvent for proactive compression and AfterModelCallEvent for overflow recovery. Available events include BeforeModelCallEvent, AfterModelCallEvent, BeforeToolCallEvent, AfterToolCallEvent, and lifecycle events.

5. STREAMING: The model returns responses as a stream of events (content deltas, tool_use starts/stops, metadata). The SDK assembles these into complete Message objects with ContentBlock arrays. Streaming is always active internally; the difference between invoke() and stream() is whether the caller sees intermediate events via an AsyncIterable.

6. INTERRUPT/RESUME: Hooks can set an interrupt on BeforeToolCallEvent to pause execution. The agent returns with stopReason='interrupt' and an interrupts array containing the pending tool calls and their inputs. The caller resumes by passing InterruptResponseContent (approved, denied, or modified) to the next invoke() call. State is preserved across the boundary.

7. METRICS: The agent tracks per-invocation metrics including inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model latency, cycle count, tool call count, and context size (message count and estimated tokens). These accumulate across invocations on a shared Agent instance. Metrics are exposed via agent.metrics and emitted as MetricsEvent.

8. MULTI-AGENT: Agents can be composed via asTool() (inner agent as a tool for outer), explicit orchestration (coordinator dispatching to workers), or pipeline patterns. Each agent maintains its own conversation history and context window, providing isolation. The SDK provides communication primitives for inter-agent state sharing.

9. ERROR HANDLING: The SDK distinguishes retryable errors (rate limits, context overflow) from fatal errors (auth failure, invalid request). Retryable errors trigger automatic recovery (backoff for rate limits, reduction for overflow). Fatal errors propagate to the caller. Tool execution errors produce error tool_results rather than throwing.

10. STATE AND PERSISTENCE: Agent state can be serialized for persistence across process boundaries (serverless, interrupt/resume). The serialization protocol captures messages, pending state, metrics, and plugin state. Deserialization reconstructs a functional agent from a snapshot.

## Tool Usage Guidelines

- Use lookup_reference to get the precise definition, examples, and history of a specific term.
- Use search_references to discover which other concepts reference or depend on a given term.
- If a tool returns a CACHE_MISS error, simply retry the same call — the index rebuilds quickly.
- Combine both tools when explaining relationships: look up the primary term, then search for what references it.
- Be concise — one to two paragraphs max per answer. Cite specific examples from the tool results.`

  const agent = createAgent(profiler, {
    systemPrompt,
    tools: [lookup, searchReferences],
  })

  // 14 questions — each is a lookup + optional cross-reference search + answer.
  const questions = [
    'What is the sliding-window conversation manager and when does it activate?',
    'How does tool-pairing work and why is it important during truncation?',
    'What triggers proactive-compression vs reactive overflow handling?',
    'Explain the interrupt/resume mechanism and how state is preserved across the boundary.',
    'How do plugins integrate with the hook system? What ordering guarantees exist?',
    'What is agent-as-tool and how does it affect context isolation?',
    'What is the difference between context-overflow and truncation?',
    'How do hooks fire relative to each other — what is the FIFO/LIFO ordering guarantee?',
    'What concepts reference or depend on the sliding-window manager?',
    'How does summarization differ from sliding-window truncation? When should each be used?',
    'Explain the tool-dispatch pipeline: validation, parallel execution, and error handling.',
    'What is message-integrity and how does the SDK enforce it?',
    'How do nested-agents and multi-agent systems relate to context management?',
    'What is state-preservation and how does it enable serverless agent deployments?',
  ]

  for (const q of questions) {
    profiler.recordInvocationInput(q)
    const result = await agent.invoke(q, { limits: { turns: 4 } })
    profiler.recordResult(result)
  }

  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
  )

  // State oracle: the agent should have performed at least one lookup per question,
  // and used search_references at least a few times for relationship questions.
  profiler.recordInvariants(
    stateConsistent(
      'lookups-performed',
      lookupsPerformed >= questions.length,
      lookupsPerformed >= questions.length
        ? `${lookupsPerformed} lookups across ${questions.length} questions (${cacheMissErrors} cache-miss retries)`
        : `only ${lookupsPerformed} lookups for ${questions.length} questions — agent skipped the tool`,
    ),
    stateConsistent(
      'cross-references-used',
      referenceSearches >= 3,
      referenceSearches >= 3
        ? `${referenceSearches} cross-reference searches performed — agent explored term relationships`
        : `only ${referenceSearches} cross-reference searches — agent underused search_references tool`,
    ),
  )
}
