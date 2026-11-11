import { bash as baseTool } from '../../../strands-ts/src/vended-tools/bash/index.js'
import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'
import { createAgent } from '../src/agent-factory.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 7

export default scenario({
  description: 'Task designed to trigger many parallel tool calls per turn where each tool returns a large result (200+ lines), so eight-plus large tool_result blocks land in a single turn and must be processed together, repeated across seven turns with a tight window and optional fork-failure chaos.',
  stresses: `How the SDK handles many tool_result blocks landing in the same turn and the sudden context spike when one turn adds tens of thousands of tokens of results at once. Parallel tool dispatch means eight or more large results arrive simultaneously and the next model call must include ALL of them as context (they share a single message), which can cause a single turn to exceed what the conversation manager expects and trigger mid-turn truncation or overflow. Doing this across seven turns repeatedly compounds the spikes and forces the manager to truncate while parallel pairs are live. The tighter window (7 instead of 8) means earlier turns get evicted sooner, so the final cross-referencing turn must work from whatever fragments survived. With CHAOS=1, ~10% of bash calls fail with "fork: Resource temporarily unavailable", forcing retries that add even more tool rounds and context churn.`,
  dimensions: ['tool-dispatch', 'context-management'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const chaos = process.env.CHAOS === '1'

  // Wrap bash to inject occasional fork failures when chaos is enabled.
  const bash = chaos
    ? tool({
        name: 'bash',
        description: baseTool.description,
        inputSchema: z.object({
          mode: z.enum(['execute', 'restart']).default('execute').describe('execution mode'),
          command: z.string().optional().describe('The bash command to run'),
        }),
        callback: async (input) => {
          if (Math.random() < 0.10) {
            return 'bash: fork: Resource temporarily unavailable'
          }
          return baseTool.invoke(input)
        },
      })
    : baseTool

  const agent = createAgent(profiler, {
    systemPrompt: `You are a code comparison assistant. When asked to compare files, read ALL of them in the SAME step by issuing every bash call at once in parallel — do NOT read one at a time. Use bounded reads (sed -n ranges) so each command is fast, but issue them all together. Then produce your analysis. If a bash call fails with "Resource temporarily unavailable", retry just that specific call immediately — do not re-read the ones that succeeded.`,
    tools: [bash],
    windowSize: WINDOW,
  })

  const tasks = [
    // Turn 1: eight parallel reads — eight large tool_result blocks share one message.
    `Read these 8 files simultaneously (issue all eight bash calls in parallel in one step, each as \`sed -n '1,220p' <path>\`), then tell me which one is longest and give a one-line summary of each:\n` +
    `strands-ts/src/agent/agent.ts, strands-ts/src/models/bedrock.ts, strands-ts/src/models/streaming.ts, strands-ts/src/hooks/events.ts, strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts, strands-ts/src/telemetry/tracer.ts, strands-ts/src/tools/tool.ts, strands-ts/src/tools/function-tool.ts`,

    // Turn 2: nine more parallel reads — another large spike on top of the first.
    `Now read these 9 files simultaneously (all bash calls in parallel, each \`sed -n '1,210p' <path>\`):\n` +
    `strands-ts/src/tools/tool-factory.ts, strands-ts/src/registry/tool-registry.ts, strands-ts/src/agent/tool-caller.ts, strands-ts/src/types/messages.ts, strands-ts/src/models/model.ts, strands-ts/src/models/anthropic.ts, strands-ts/src/conversation-manager/summarizing-conversation-manager.ts, strands-ts/src/retry/default-model-retry-strategy.ts, strands-ts/src/hooks/registry.ts.\n` +
    `Compare their export patterns — which define classes vs plain functions vs type-only exports? Note the line numbers of each export statement.`,

    // Turn 3: eight more parallel reads — third spike; earliest reads heavily truncated.
    `Now read these 8 files simultaneously (all in parallel, each \`sed -n '1,200p' <path>\`):\n` +
    `strands-ts/src/agent/agent.ts (lines 200-400 this time: \`sed -n '200,400p'\`), strands-ts/src/models/bedrock.ts (lines 100-300: \`sed -n '100,300p'\`), strands-ts/src/telemetry/tracer.ts (lines 50-250: \`sed -n '50,250p'\`), strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts (lines 80-280: \`sed -n '80,280p'\`), strands-ts/src/hooks/events.ts (lines 40-240: \`sed -n '40,240p'\`), strands-ts/src/tools/tool.ts (lines 50-250: \`sed -n '50,250p'\`), strands-ts/src/types/messages.ts (lines 60-260: \`sed -n '60,260p'\`), strands-ts/src/agent/tool-caller.ts (lines 30-230: \`sed -n '30,230p'\`).\n` +
    `For each file, identify the most complex function in this range and note its exact line numbers.`,

    // Turn 4: ten parallel reads — heaviest batch yet, maximum parallel pressure.
    `Now read these 10 files simultaneously (all in parallel, each \`sed -n '1,200p' <path>\`):\n` +
    `strands-ts/src/agent/agent.ts, strands-ts/src/models/bedrock.ts, strands-ts/src/models/streaming.ts, strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts, strands-ts/src/conversation-manager/summarizing-conversation-manager.ts, strands-ts/src/tools/tool-factory.ts, strands-ts/src/hooks/events.ts, strands-ts/src/hooks/registry.ts, strands-ts/src/telemetry/tracer.ts, strands-ts/src/retry/default-model-retry-strategy.ts.\n` +
    `For each file: count the number of import statements, identify the primary exported entity, and note if it extends or implements another type (with line number).`,

    // Turn 5: eight parallel reads of deeper sections — fourth spike after heavy truncation.
    `Now read deeper sections of these 8 files simultaneously (all in parallel):\n` +
    `strands-ts/src/agent/agent.ts (lines 400-600: \`sed -n '400,600p'\`), strands-ts/src/models/bedrock.ts (lines 300-500: \`sed -n '300,500p'\`), strands-ts/src/models/streaming.ts (lines 150-350: \`sed -n '150,350p'\`), strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts (lines 200-400: \`sed -n '200,400p'\`), strands-ts/src/tools/tool-factory.ts (lines 100-300: \`sed -n '100,300p'\`), strands-ts/src/hooks/events.ts (lines 150-350: \`sed -n '150,350p'\`), strands-ts/src/telemetry/tracer.ts (lines 100-300: \`sed -n '100,300p'\`), strands-ts/src/types/messages.ts (lines 200-400: \`sed -n '200,400p'\`).\n` +
    `Identify error handling patterns in this range: try/catch blocks, error type checks, re-throws. Note exact line numbers for each.`,

    // Turn 6: nine parallel reads — fifth spike; window now extremely tight.
    `Now read these 9 files simultaneously (all in parallel, each \`sed -n '1,200p' <path>\`):\n` +
    `strands-ts/src/agent/agent.ts, strands-ts/src/models/model.ts, strands-ts/src/models/anthropic.ts, strands-ts/src/models/bedrock.ts, strands-ts/src/conversation-manager/sliding-window-conversation-manager.ts, strands-ts/src/tools/tool.ts, strands-ts/src/registry/tool-registry.ts, strands-ts/src/retry/default-model-retry-strategy.ts, strands-ts/src/agent/tool-caller.ts.\n` +
    `For each: identify the primary interface or abstract type it defines/implements, and note which other files from our prior reads depend on it (reference specific line numbers from earlier reads where you saw the import).`,

    // Turn 7: final synthesis — cross-references ALL seven prior turns.
    `Based on EVERYTHING you have read across all six prior batches (turns 1-6), produce a comprehensive cross-reference analysis:\n` +
    `1. Which file has the most complex error handling? Cite the specific line numbers from Turn 5 where you saw the deepest try/catch nesting.\n` +
    `2. Which file has the most imports? Cite the count from Turn 4.\n` +
    `3. Identify the top-3 files by total complexity (combining method count from Turn 1, nesting depth from Turn 3, error handling from Turn 5). Justify with specific line numbers.\n` +
    `4. Map the dependency chain: starting from agent.ts, trace through which files it imports (Turn 1/4), which of those define interfaces others implement (Turn 6), and which have retry/error patterns (Turn 5). Draw the chain with line-number citations.\n` +
    `5. Which export patterns from Turn 2 are inconsistent with the interface patterns from Turn 6? Cite specific line numbers from both.\n` +
    `6. If any file has aged out of your context entirely, say so explicitly rather than guessing — and note which turn you originally read it in.`,
  ]

  for (const task of tasks) {
    profiler.recordInvocationInput(task)
    const result = await agent.invoke(task, { limits: { turns: 4 } })
    profiler.recordResult(result)
  }

  // SDK invariants (deterministic, model-independent) read off the final log.
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )
}
