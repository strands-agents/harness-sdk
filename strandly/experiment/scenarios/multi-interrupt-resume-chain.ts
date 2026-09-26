import { createAgent } from '../src/agent-factory.js'
import { tool } from '../../../strands-ts/src/tools/tool-factory.js'
import { BeforeToolCallEvent } from '../../../strands-ts/src/hooks/events.js'
import { InterruptResponseContent } from '../../../strands-ts/src/types/interrupt.js'
import { z } from 'zod'
import { scenario } from '../src/scenario.js'
import { toolPairingIntact, historyWellFormed, stateConsistent } from '../src/invariants.js'
import type { ProfilerObserver } from '../src/observer.js'

export default scenario({
  description: 'Agent is interrupted FOUR times across a single task — at steps 4, 9, 14, and 18 of a 20-step deployment — and must resume coherently each time, continuing from exactly where it left off. Steps produce data (deployment IDs, canary metrics) that later steps must reference.',
  stresses: 'Multiple interrupt/resume cycles within a single logical task with data dependencies between steps. Each resume re-enters the agent loop with the interrupt response prepended to history. After four interrupts, the message history contains four interrupt boundaries, four resume entries, and all the work in between. The SDK must preserve message continuity across each boundary, not duplicate tool results from before the interrupt, and not confuse the model about which steps are already done. Under CHAOS mode, check_progress occasionally returns stale data, forcing the agent to handle discrepancies.',
  dimensions: ['interrupt-resume', 'agent-loop'],
  run,
})

async function run(profiler: ProfilerObserver) {
  const CHAOS = process.env.CHAOS === '1'
  const completedSteps: string[] = []
  const stepResults: Record<number, Record<string, string>> = {}
  let toolCallCount = 0
  const INTERRUPT_AT = [4, 9, 14, 18]

  const executeStep = tool({
    name: 'execute_step',
    description: 'Execute a numbered step of the deployment pipeline. Returns confirmation with the step result including any generated IDs, metrics, or references needed by later steps.',
    inputSchema: z.object({ step: z.number(), action: z.string(), references: z.record(z.string(), z.string()).optional() }),
    callback: (input) => {
      completedSteps.push(`step-${input.step}`)
      // Generate step-specific result data that later steps depend on
      const result: Record<string, string> = { status: 'completed', action: input.action }
      switch (input.step) {
        case 1: result.snapshotId = 'snap-20260625-a3f7'; break
        case 2: result.maintenanceToken = 'maint-tok-9x2k'; break
        case 3: result.deploymentId = 'deploy-4f8a-blue'; break
        case 5: result.migrationVersion = 'v42.schema.7'; break
        case 7: result.canaryId = 'canary-deploy-4f8a-001'; break
        case 8: result.canaryHealthScore = '98.7'; break
        case 10: result.trafficSplitId = 'split-4f8a-50pct'; break
        case 12: result.smokeTestSuiteId = 'smoke-run-28847'; result.passRate = '100%'; break
        case 14: result.rollbackPlan = 'rb-plan-4f8a-rev3'; break
        case 16: result.dnsPropagationId = 'dns-prop-4f8a-final'; break
        case 18: result.finalHealthCheck = 'healthy'; result.p99Latency = '142ms'; break
        case 20: result.deploymentRecord = 'record-4f8a-complete'; break
      }
      stepResults[input.step] = result
      return JSON.stringify({
        step: input.step,
        totalCompleted: completedSteps.length,
        ...result,
      })
    },
  })

  const checkProgress = tool({
    name: 'check_progress',
    description: 'Check which steps have been completed, their results, and timing information.',
    inputSchema: z.object({}),
    callback: () => {
      const stepsToReport = [...completedSteps]
      // CHAOS: occasionally return stale data (missing most recent step)
      if (CHAOS && stepsToReport.length > 0 && Math.random() < 0.15) {
        stepsToReport.pop()
      }
      return JSON.stringify({
        completed: stepsToReport,
        count: stepsToReport.length,
        remaining: 20 - stepsToReport.length,
        timing: {
          startedAt: '2026-06-25T14:00:00Z',
          lastStepAt: new Date().toISOString(),
          elapsedSeconds: stepsToReport.length * 12,
        },
        stepResults: Object.fromEntries(
          Object.entries(stepResults).filter(([k]) => stepsToReport.includes(`step-${k}`))
        ),
      })
    },
  })

  const agent = createAgent(profiler, {
    systemPrompt: `You are executing a 20-step blue-green deployment pipeline. Execute each step in order using execute_step. Some steps produce IDs and metrics that MUST be referenced by later steps — pass them via the "references" field.

After each resume from an interrupt, call check_progress first to see exactly which steps are done and their results, then continue from the next incomplete step. Never re-execute a step that is already completed. Never skip a step. If check_progress seems slightly stale (missing a step you just saw complete), trust your own memory of recent completions and continue forward.`,
    tools: [executeStep, checkProgress],
  })

  agent.addHook(BeforeToolCallEvent, (event) => {
    if (event.toolUse.name === 'execute_step') {
      toolCallCount++
      if (INTERRUPT_AT.includes(toolCallCount)) {
        event.interrupt({ name: 'approval-gate', reason: `Deployment gate: pausing for approval at tool call #${toolCallCount} (step ${JSON.parse(JSON.stringify(event.toolUse.input)).step})` })
      }
    }
  })

  const task = `Execute all 20 steps of the blue-green deployment pipeline in order:
1. Create database backup snapshot (produces snapshotId for rollback reference)
2. Enable maintenance mode on current production (produces maintenanceToken)
3. Provision new blue environment (produces deploymentId used by all subsequent steps)
4. Warm up application caches in blue environment
5. Run database migration on blue environment (produces migrationVersion — reference deploymentId from step 3)
6. Deploy application v2.4.1 to blue environment (reference deploymentId from step 3)
7. Start canary deployment — route 5% of traffic to blue (produces canaryId — reference deploymentId)
8. Monitor canary health for stability check (produces canaryHealthScore — reference canaryId from step 7)
9. Increase traffic to blue: 5% → 25% (reference canaryId, require canaryHealthScore ≥ 95)
10. Increase traffic to blue: 25% → 50% (produces trafficSplitId — reference canaryId)
11. Run integration test suite against blue at 50% load (reference trafficSplitId from step 10)
12. Run smoke test suite against blue environment (produces smokeTestSuiteId and passRate — reference deploymentId)
13. Increase traffic to blue: 50% → 90% (reference trafficSplitId, require passRate = 100%)
14. Generate rollback plan for green environment (produces rollbackPlan — reference deploymentId and snapshotId from step 1)
15. Increase traffic to blue: 90% → 100% (reference rollbackPlan from step 14)
16. Update DNS records to point to blue environment (produces dnsPropagationId — reference deploymentId)
17. Wait for DNS propagation and verify (reference dnsPropagationId from step 16)
18. Final health check on blue environment (produces finalHealthCheck and p99Latency — reference deploymentId)
19. Decommission green environment (reference deploymentId, require finalHealthCheck = healthy)
20. Disable maintenance mode and archive deployment record (produces deploymentRecord — reference maintenanceToken from step 2, deploymentId from step 3)

Execute each step with execute_step providing the step number, action description, and any references to IDs/data from prior steps. Do all 20 in sequence.`

  profiler.recordInvocationInput(task)
  let result = await agent.invoke(task, { limits: { turns: 30 } })
  profiler.recordResult(result)

  // Resume loop — keep resuming until the agent finishes or we run out of interrupts.
  let resumeCount = 0
  while (result.stopReason === 'interrupt' && result.interrupts?.length && resumeCount < 6) {
    resumeCount++
    const responses = result.interrupts.map(interrupt =>
      new InterruptResponseContent({ interruptId: interrupt.id, response: 'approved — continue deployment from where you left off' })
    )
    profiler.recordInvocationInput(`[resume ${resumeCount}] continue deployment pipeline`)
    result = await agent.invoke(responses, { limits: { turns: 30 } })
    profiler.recordResult(result)
  }

  profiler.recordInvariants(
    toolPairingIntact(agent.messages),
    historyWellFormed(agent.messages),
  )

  // State oracle: all 20 steps should be completed exactly once.
  const uniqueSteps = new Set(completedSteps)
  const allDone = uniqueSteps.size === 20
  const noDuplicates = completedSteps.length === uniqueSteps.size
  profiler.recordInvariants(
    stateConsistent(
      'all-steps-completed-once',
      allDone && noDuplicates,
      allDone && noDuplicates
        ? `all 20 steps completed exactly once across ${resumeCount + 1} invocations (${resumeCount} resumes)`
        : `${uniqueSteps.size}/20 unique steps, ${completedSteps.length} total executions (duplicates: ${completedSteps.length - uniqueSteps.size}), ${resumeCount} resumes`,
    ),
  )
}
