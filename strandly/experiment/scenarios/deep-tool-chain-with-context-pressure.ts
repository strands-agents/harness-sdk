import { createAgent } from '../src/agent-factory.js'
import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 7

export default scenario({
  description: 'An agent reads twelve real source files across the agent, tools, conversation-manager, models, hooks, retry, session, and telemetry subsystems and must cross-reference their error-handling under a tight context window with no external storage to fall back on.',
  stresses: `Conversation manager truncation of many large tool results (substantial source-file slices) competing for space in a small window, and whether tool_use/tool_result pairing survives that truncation. Twelve reads against a windowSize of 7 guarantee the earliest files are forced out well before the synthesis turn. If it drops mid-JSON or mid-code-block the agent sees corrupt context; if it drops entire messages the agent loses files it already read — so its truncation decisions directly shape a synthesis that depends on the earliest reads. Under CHAOS mode, locale warnings injected into bash output add parsing noise the agent must ignore.`,
  dimensions: ['context-management', 'tool-dispatch'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const CHAOS = process.env.CHAOS === '1'

  // A bash-like tool that optionally injects locale noise
  const bashTool = tool({
    name: 'bash',
    description: 'Execute a bash command and return stdout/stderr.',
    inputSchema: z.object({ command: z.string() }),
    callback: async (input) => {
      const { execSync } = await import('node:child_process')
      const cwd = process.cwd().replace(/\/strandly\/experiment$/, '/strands-ts')
      let output: string
      try {
        output = execSync(input.command, { encoding: 'utf-8', cwd, timeout: 10000 })
      } catch (e: any) {
        output = e.stderr || e.message || 'command failed'
      }
      // CHAOS: ~8% of calls prepend a locale warning
      if (CHAOS && Math.random() < 0.08) {
        output = "bash: warning: setlocale: LC_ALL: cannot change locale\n" + output
      }
      return output
    },
  })

  const agent = createAgent(profiler, {
    systemPrompt: `You are a code reviewer performing a cross-file analysis. Read each file as instructed using BOUNDED commands (sed -n ranges, grep -n) — never cat a whole large file. You do NOT have external storage — everything must stay in your working memory. Read carefully and remember what you find, because earlier files WILL become unavailable as the conversation grows past the context window. Ignore any locale warnings in bash output — they are harmless noise.`,
    tools: [bashTool],
    windowSize: WINDOW,
  })

  // Multi-turn: each invoke adds pressure. By the time we ask for synthesis,
  // the early file reads are guaranteed to be truncated out of the window.
  // Reads are BOUNDED (sed -n ranges) so no single tool result is unbounded,
  // but twelve of them in a 7-message window forces hard truncation.
  const steps = [
    'Read the error-handling code in strands-ts/src/agent/agent.ts with: grep -n "throw\\|Error\\|catch\\|class .*Error" strands-ts/src/agent/agent.ts. Then read sed -n \'1,140p\' strands-ts/src/agent/agent.ts to see the imports and top-level error types. Summarize what errors this file defines or throws and remember them.',
    'Read strands-ts/src/agent/tool-caller.ts in full with sed -n \'1,294p\'. Note every place it catches an error, wraps one, or produces an error tool_result. Also note which specific error classes it imports from other files.',
    'Read strands-ts/src/registry/tool-registry.ts in full with sed -n \'1,161p\'. Note how it reports unknown/duplicate tools and any errors it throws. Remember the exact error messages it uses.',
    'Read strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts with sed -n \'1,230p\' then sed -n \'231,458p\'. Note the error type it throws when context cannot be reduced, and what conditions trigger it.',
    'Read strands-ts/src/conversation-manager/summarizing-conversation-manager.ts in full with sed -n \'1,174p\'. Note how it handles summarization failures versus the sliding-window manager. What does it do when the LLM summarization call itself fails?',
    'Read the error handling in strands-ts/src/models/bedrock.ts with: grep -n "throw\\|Error\\|catch\\|Exception" strands-ts/src/models/bedrock.ts, then read the relevant slices with sed -n ranges around the matches (keep each slice under ~100 lines). Note every distinct error type and which AWS exceptions it maps.',
    'Read strands-ts/src/retry/default-model-retry-strategy.ts in full with sed -n \'1,141p\'. Note which errors it considers retryable and which it rethrows. What specific HTTP status codes or error names does it check?',
    'Read the error handling in strands-ts/src/models/streaming.ts with: grep -n "throw\\|Error\\|guard\\|invalid" strands-ts/src/models/streaming.ts, then read sed -n \'1,120p\' for the type guards. Note how malformed stream events are handled — does it throw or silently skip?',
    'Read strands-ts/src/hooks/registry.ts with sed -n \'1,150p\'. Note what happens when a hook callback throws — does the registry catch it, propagate it, or log it? Does it stop dispatching to subsequent hooks?',
    'Read strands-ts/src/hooks/events.ts with grep -n "Error\\|error\\|throw\\|catch" strands-ts/src/hooks/events.ts, then sed -n \'1,100p\'. Note which event classes carry error payloads and how errors flow through the event system.',
    'Read strands-ts/src/tools/tool-factory.ts with sed -n \'1,150p\'. Note how it wraps user-provided callbacks — what happens when a tool callback throws? Does it produce a specific error format in tool_result?',
    'Read strands-ts/src/agent/snapshot.ts with sed -n \'1,120p\'. Note what errors can occur during snapshot serialization and how they are handled — does a snapshot failure kill the agent loop or is it swallowed?',
    // Synthesis turns that require recall from early reads
    'Now, WITHOUT re-reading any files, produce a detailed cross-file error-handling comparison covering ALL twelve files. For each file: (a) which error types it defines or throws, (b) whether it wraps or rethrows, (c) what the error message text looks like, and (d) where errors cross subsystem boundaries (e.g. a model error reaching the tool-caller, or a conversation-manager error reaching the agent loop). Call out inconsistencies — different files naming the same failure differently, or one swallowing what another rethrows. Reference specific line numbers you observed earlier. If a file has aged out of your memory, say so explicitly rather than inventing details.',
    'Finally, answer these cross-referencing questions that span the earliest and latest files you read: (1) When a tool callback throws (tool-factory.ts), trace the error path all the way up through tool-caller.ts to agent.ts — does the error ever get swallowed? (2) When bedrock.ts throws a retryable error, how does retry/default-model-retry-strategy.ts decide to retry vs. rethrow, and does the hook system (hooks/registry.ts) see the retry attempts? (3) When the sliding-window-conversation-manager throws its "cannot reduce" error, where does agent.ts catch it and what does it do? Cite the specific line numbers and error class names from your earlier reads.',
  ]

  for (const step of steps) {
    profiler.recordInvocationInput(step)
    const result = await agent.invoke(step, { limits: { turns: 4 } })
    profiler.recordResult(result)
  }

  // SDK invariants (deterministic, model-independent) read off the final log.
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )
}
