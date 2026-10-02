import { Agent } from '../../../strands-ts/src/agent/agent.js'
import { bash } from '../../../strands-ts/src/vended-tools/bash/index.js'
import { createAgent } from '../src/agent-factory.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 8

export default scenario({
  description: 'An outer agent delegates fourteen research questions to an inner researcher agent that reads real source files across the agent loop, tool dispatch, conversation managers, hooks/plugins, Bedrock streaming, event assembly, retry, session management, telemetry, and snapshot subsystems, then must reconcile all fourteen accumulated findings under a tight context window.',
  stresses: `Agent-as-tool result serialization into the parent's context, and the conversation manager's handling of many large tool_result blocks from nested agents. With windowSize: 8 and fourteen detailed researcher reports accumulated before the synthesis turn, the earliest findings are forced out, so the outer agent must reconcile across subsystems whose detail has aged out — and must cope when an inner agent hits its own limits and returns a partial result. Under CHAOS mode, the inner agent occasionally times out, returning partial results that the outer agent must work around. A weaker truncation strategy degrades the cross-subsystem synthesis more.`,
  dimensions: ['nested-agents', 'context-management'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const CHAOS = process.env.CHAOS === '1'

  const researcher = new Agent({
    name: 'code_researcher',
    description: 'Investigates a specific technical question about the strands-ts codebase. Reads source files, traces call chains, and returns detailed findings with exact line numbers, function signatures, and return types. Occasionally may time out on complex queries.',
    model: 'us.anthropic.claude-sonnet-4-6',
    systemPrompt: `You are a thorough code researcher. When given a question:
1. Use bash to read the specific source file(s) named in the question. Use BOUNDED reads only — sed -n '1,120p' file, head -120 file, or grep -n 'pattern' file. Never cat a whole large file; never run find over the whole repo. Keep every command fast.
2. Trace the relevant code paths within what you read.
3. Return a detailed answer with file paths, EXACT line numbers, full function signatures (including parameter types and return types), and short code excerpts.
Be thorough in your analysis but keep excerpts focused — include the actual key lines, not entire files.`,
    tools: [bash],
    printer: false,
  })

  // Wrap the researcher to inject CHAOS timeouts via a middleware agent
  const baseResearcher = researcher.asTool()
  let researcherTool = baseResearcher
  if (CHAOS) {
    // In CHAOS mode, we intercept by wrapping the agent's invoke with a proxy
    const originalInvoke = researcher.invoke.bind(researcher)
    researcher.invoke = async (...args: Parameters<typeof researcher.invoke>) => {
      if (Math.random() < 0.10) {
        return { stopReason: 'end_turn', output: 'research incomplete: timed out after 30s — partial findings: began reading the target file but could not complete analysis within time limit. Retry with a more specific question or proceed with available information.' } as any
      }
      return originalInvoke(...args)
    }
    researcherTool = researcher.asTool()
  }

  const agent = createAgent(profiler, {
    systemPrompt: `You are a senior engineer writing a technical design document. You have a code_researcher tool that investigates questions about the codebase. Use it to gather information, then synthesize.

Important: the researcher returns detailed findings with code excerpts, exact line numbers, and full function signatures. Your job is to identify patterns, contradictions, and architectural implications across multiple findings — not just summarize each one. If the researcher times out or returns partial results, note the gap and work around it — do not let a single timeout block your synthesis.`,
    tools: [researcherTool],
    windowSize: WINDOW,
  })

  const tasks = [
    'Ask the researcher: How does the Agent class handle the lifecycle of a single invoke() call? Read strands-ts/src/agent/agent.ts and trace all the steps from receiving input to returning AgentResult, including where the event loop iterates. Report the exact signature of invoke() and the type of AgentResult.',
    'Ask the researcher: How does tool dispatch work? Read strands-ts/src/agent/tool-caller.ts and strands-ts/src/registry/tool-registry.ts and trace from when the model returns a tool_use block to when the tool_result is added to messages. What is the exact signature of callTools()? How are parallel tool calls handled — sequential or concurrent?',
    'Ask the researcher: How does the sliding-window conversation manager decide what to truncate? Read strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts and explain the reduceContext algorithm. What is the exact method signature? How does it preserve tool_use/tool_result pairing — what specific check prevents orphaned pairs?',
    'Ask the researcher: How does the summarizing conversation manager differ? Read strands-ts/src/conversation-manager/summarizing-conversation-manager.ts and contrast its reduction approach with the sliding-window one. What does it call, what does it keep, and what is the fallback if summarization fails?',
    'Ask the researcher: How do hooks and plugins integrate? Read strands-ts/src/hooks/registry.ts and strands-ts/src/plugins/registry.ts. What are the exact registration method signatures? How does dispatch order work — FIFO, LIFO, or priority-based? What happens when a hook throws?',
    'Ask the researcher: What hook events fire during a single invoke, and in what order? Read strands-ts/src/hooks/events.ts and list every event class, its payload type, and at what point in the agent loop lifecycle it fires. Report the exact class hierarchy.',
    'Ask the researcher: How does the Bedrock model turn a request into streamed events? Read strands-ts/src/models/bedrock.ts and trace how stream() builds the converse input and yields ModelStreamEvent values. What is the exact signature of stream()? What AWS SDK types does it map to/from?',
    'Ask the researcher: How are streamed model events assembled back into a Message? Read strands-ts/src/models/streaming.ts and explain the event union, how content blocks are accumulated from deltas, and what type guards validate the stream. Report exact function signatures.',
    'Ask the researcher: How does retry wrap model calls? Read strands-ts/src/retry/default-model-retry-strategy.ts and explain the exact retry conditions — which error types, which HTTP status codes, what backoff strategy. What is the return type and how does it interact with streaming?',
    'Ask the researcher: How does session management persist and restore agent state? Read strands-ts/src/session/session-manager.ts and trace how save() and load() work. What format is used for serialization? What are the exact method signatures?',
    'Ask the researcher: How does the snapshot system capture agent state for debugging? Read strands-ts/src/agent/snapshot.ts and explain what data it captures, when snapshots are taken during the agent loop, and how they relate to the session manager. What is the snapshot format?',
    'Ask the researcher: How does the telemetry/tracer integrate with the agent loop? Read strands-ts/src/telemetry/tracer.ts and explain what spans it creates, what attributes it records, and at what points in the invoke lifecycle traces are started/ended. What tracing standard does it follow?',
    'Ask the researcher: How does the tool-factory create tools from different input formats? Read strands-ts/src/tools/tool-factory.ts and strands-ts/src/tools/function-tool.ts. What overloads does the tool() factory support? How does it normalize schema validation? What is the exact type signature of the tool() function?',
    'Ask the researcher: How does the conversation-manager interface define the contract? Read strands-ts/src/conversation-manager/conversation-manager.ts and strands-ts/src/models/model.ts. What methods must a conversation manager implement? What methods must a model implement? How do these two interfaces compose during an invoke call?',
    // Synthesis turn requiring cross-referencing ALL 14 findings
    'Now synthesize across ALL fourteen research findings into a comprehensive technical design document. Structure it as:\n\n1. **Request Lifecycle**: How a single invoke() flows through agent → model → streaming → tool-caller → hooks → conversation-manager → session/snapshot/telemetry. Cite the exact function signatures the researcher reported for each boundary.\n\n2. **State Management**: How message history, session persistence, snapshots, and conversation-manager truncation interact. Where is state created, where is it reduced, and where is it persisted?\n\n3. **Error & Retry Paths**: How errors propagate across the subsystem boundaries — a model error through retry to the agent loop, a tool error through tool-caller to hooks, a truncation failure through the conversation manager.\n\n4. **Risks and Coupling**: Where do these subsystems interact in ways that could cause tool-pairing corruption, lost context, duplicated work under retry, or stale session state? Cite specifics from the researcher findings for each risk.\n\n5. **Gaps**: Which subsystems returned partial or timed-out research results? What questions remain unanswered?\n\nYou MUST cite specific findings (line numbers, signatures, types) from the researcher for each subsystem. For any whose details have aged out of your context, say so explicitly rather than inventing.',
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 5 } })
    profiler.recordResult(result)
  }

  // SDK invariants (deterministic, model-independent) read off the outer agent's final log.
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )
}
