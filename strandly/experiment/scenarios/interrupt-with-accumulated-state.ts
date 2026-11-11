import { bash } from '../../../strands-ts/src/vended-tools/bash/index.js'
import { BeforeToolCallEvent } from '../../../strands-ts/src/hooks/events.js'
import { InterruptResponseContent } from '../../../strands-ts/src/types/interrupt.js'
import { makeKvStore } from '../src/tools/kv-store.js'
import { createAgent } from '../src/agent-factory.js'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, contextUnderWindow, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

const WINDOW = 16
// Interrupt deeper into the run so substantial state has accumulated first.
// Each analysis step is ~3-4 tool calls (bash grep + bash read + kv_set + optional
// kv_get for dependent steps), so 20 means ~5-6 steps completed with several kv
// keys stored at the interrupt instant. The verbose kv-store responses add
// token weight per tool call, compounding truncation pressure.
const INTERRUPT_AT = 20

export default scenario({
  description: 'Agent builds up substantial working state across many tool calls (a 10-section migration plan persisted to a verbose kv-store with pagination and optional stale-read chaos), gets interrupted well into the operation, then resumes and continues coherently with all prior state intact.',
  stresses: `State consistency across interrupt boundaries when the agent has accumulated a large external state (many kv keys with version metadata) plus in-context state that may diverge after resume. The kv-store returns verbose JSON envelopes ({found, key, value, version, sizeBytes}) that inflate context faster than the simple store, and paginated list means the agent cannot see all keys in one call if more than 10 accumulate. With CHAOS=1, ~15% of reads immediately after a write return STALE_READ warnings forcing retries — injecting extra tool rounds that accelerate truncation. The interrupt fires after 20 tool calls, so a lot of pre-interrupt history precedes it. Messages added before the interrupt stay in history, and on resume those messages plus the interrupt response form the new context. With a sliding window that has already truncated, resume preparation must not drop the head of the conversation or strand a tool_use without its result — and the agent must rediscover, from the kv store (via paginated list + individual gets), the findings it made before the pause to finish the remaining sections.`,
  dimensions: ['interrupt-resume', 'state-consistency'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const chaos = process.env.CHAOS === '1'
  const kv = makeKvStore({ unreliable: chaos })
  let toolCallCount = 0
  // Snapshot of which kv keys existed at the moment of the interrupt, so the
  // oracle can assert the PRE-interrupt findings specifically survived resume.
  let preInterruptKeys: string[] = []

  const agent = createAgent(profiler, {
    systemPrompt: `You are a migration planner. You analyze source files and build a detailed migration plan step by step, storing each step's findings in the kv store under the named key as you go. Store findings as you complete each step — do not batch them to the end.

IMPORTANT: The kv store returns verbose JSON responses. A successful kv_get looks like {"found":true,"key":"...","value":"...","version":N,"sizeBytes":N}. If you see a response with "warning":"STALE_READ" it means the value is stale — you MUST retry the kv_get after a moment. A successful kv_set looks like {"success":true,"key":"...","version":N,"sizeBytes":N}. The kv_list is paginated — if "hasMore":true, call again with the returned nextCursor.

If interrupted, use kv_list (paginating if needed) then kv_get on each key to see exactly what you already completed and continue from where you left off without redoing finished steps. Handle STALE_READ by retrying.`,
    tools: [bash, ...kv.tools],
    windowSize: WINDOW,
  })

  // Interrupt after the agent has done substantial work. Capture the live kv
  // keys at that instant — these are the findings that must survive the
  // interrupt/resume boundary.
  agent.addHook(BeforeToolCallEvent, async (event) => {
    toolCallCount++
    if (toolCallCount === INTERRUPT_AT) {
      const listResult = JSON.parse(String(await kv.list.invoke({})))
      preInterruptKeys = listResult.keys as string[]
      // If paginated, grab all pages for the snapshot
      if (listResult.hasMore) {
        let cursor = listResult.nextCursor
        while (cursor !== null) {
          const page = JSON.parse(String(await kv.list.invoke({ cursor })))
          preInterruptKeys = [...preInterruptKeys, ...page.keys]
          cursor = page.hasMore ? page.nextCursor : null
        }
      }
      event.interrupt({ name: 'review-checkpoint', reason: 'Pausing for human review of migration plan so far' })
    }
  })

  // A larger plan with ten findings to persist, several of which depend on
  // earlier ones (e.g. extraction candidates reference the public-method and
  // dependency lists, the risk assessment references complexity analysis). The
  // dependent later steps mean the post-resume work genuinely needs the
  // pre-interrupt findings out of the kv store.
  const task = `Build a comprehensive migration plan for refactoring strands-ts/src/agent/agent.ts into a modular architecture. Work through these steps IN ORDER, storing each step's result in the kv store under the given key as soon as you finish it (use bash with head/grep/sed to inspect the file — keep every bash command bounded to specific line ranges):

1. List all public methods of the Agent class with their parameter signatures and return types. For each method, note whether it's synchronous or async. (store the full list in kv as "public-methods")

2. Read the constructor and produce a dependency graph: list all constructor dependencies / injected collaborators, noting which are required vs optional, their types, and whether they have defaults. Identify any circular-dependency risk. (store in kv as "dependencies")

3. Find all private methods, categorize them by purpose (lifecycle, tool-dispatch, state-management, model-interaction, error-handling), and note their call relationships (which private methods call which others). (store in kv as "private-methods")

4. Map the import graph: list all imports from other local modules, grouped by subsystem (conversation-manager/, models/, tools/, hooks/, telemetry/, types/). Note which imports are type-only vs runtime. (store in kv as "local-imports")

5. Identify the external (non-relative) imports. For each, note whether it's a dev dependency, a peer dependency, or a direct dependency, and what it's used for. (store in kv as "external-imports")

6. Perform a complexity analysis: identify the three longest methods by line count, the method with the deepest nesting, and any methods with cyclomatic complexity > 5 (estimate from branches/loops). Note async control flow patterns (try/catch nesting, Promise.all, etc). (store in kv as "complexity-analysis")

7. Using the public-methods and dependencies findings, identify which public methods could be extracted into a separate class. For each candidate, explain what state it needs, what it would take as constructor args, and estimate the migration difficulty (easy/medium/hard). (store in kv as "extraction-candidates")

8. Identify all hook integration points: where the agent fires events, which hooks can intercept, and the data contract at each point. Map the event flow through a typical invoke() call. (store in kv as "hook-integration")

9. Using the complexity-analysis and private-methods findings, identify methods that touch the conversation manager or model directly and would need an interface boundary in the migration. For each, describe the current coupling and propose the interface shape. (store in kv as "boundary-methods")

10. Produce a final migration plan that references ALL nine stored findings by name. Structure it as phases (Phase 1: extract X, Phase 2: introduce interface Y, etc), with a risk assessment for each phase based on the complexity analysis. Include estimated effort and a dependency ordering between phases. (store in kv as "migration-plan")`

  // First run — will be interrupted after INTERRUPT_AT tool calls.
  profiler.recordInvocationInput(task)
  const result1 = await agent.invoke(task)
  profiler.recordResult(result1)

  // Resume — agent should check kv store and continue from where it left off.
  if (result1.stopReason === 'interrupt' && result1.interrupts?.length) {
    const responses = result1.interrupts.map(interrupt =>
      new InterruptResponseContent({ interruptId: interrupt.id, response: 'approved — continue with the migration plan, finishing every remaining step and the final plan. Check the kv store first to see what was already completed.' })
    )
    profiler.recordInvocationInput('[resume] continue migration plan from checkpoint')
    const result2 = await agent.invoke(responses)
    profiler.recordResult(result2)
  }

  // SDK invariants (deterministic, model-independent) read off the final log.
  // Runs regardless of whether the resume branch executed.
  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
    contextUnderWindow(agent.messages, WINDOW),
  )

  // State oracle: findings the agent stored in the kv store BEFORE the interrupt
  // must survive the interrupt/resume boundary. We captured the exact set of
  // keys present at the moment of interrupt; assert every one of them is still
  // present after resume. If resume preparation truncated away the agent's
  // awareness AND the persisted state were lost, those specific keys would be
  // gone. This is stronger than "the store is non-empty": it pins the survival
  // to the pre-interrupt findings rather than letting post-resume writes mask a
  // loss.
  const listResult = JSON.parse(String(await kv.list.invoke({})))
  let keys: string[] = listResult.keys
  if (listResult.hasMore) {
    let cursor = listResult.nextCursor
    while (cursor !== null) {
      const page = JSON.parse(String(await kv.list.invoke({ cursor })))
      keys = [...keys, ...page.keys]
      cursor = page.hasMore ? page.nextCursor : null
    }
  }
  const liveSet = new Set(keys)
  const lostPreInterrupt = preInterruptKeys.filter((k) => !liveSet.has(k))
  // If no interrupt fired (e.g. the model finished in fewer than INTERRUPT_AT
  // tool calls), preInterruptKeys is empty; fall back to the non-empty check so
  // the oracle still reports meaningfully rather than vacuously passing.
  const survived = preInterruptKeys.length > 0
    ? lostPreInterrupt.length === 0
    : keys.length > 0
  profiler.recordInvariants(
    stateConsistent(
      'kv-survived-interrupt',
      survived,
      preInterruptKeys.length > 0
        ? (survived
            ? `all ${preInterruptKeys.length} pre-interrupt kv findings survived resume [${preInterruptKeys.join(', ')}]; ${keys.length} total keys now`
            : `pre-interrupt findings lost across resume: [${lostPreInterrupt.join(', ')}] missing (had [${preInterruptKeys.join(', ')}], now [${keys.join(', ')}])`)
        : (survived
            ? `no interrupt fired; ${keys.length} kv findings present [${keys.join(', ')}]`
            : 'kv store is empty after run — no finding persisted'),
    ),
  )
}
