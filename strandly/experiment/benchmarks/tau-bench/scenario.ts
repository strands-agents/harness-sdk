/**
 * tau-bench scenario — multi-turn customer service benchmark.
 *
 * Runs N tasks from Sierra Research's tau-bench (retail or airline domain),
 * driving an agent through multi-turn tool-use conversations scored against
 * ground-truth state and output expectations.
 *
 * Env vars:
 *   TAU_BENCH_ENV=retail            — environment (retail or airline)
 *   TAU_BENCH_LIMIT=5               — tasks to run (default 5, 0 = all)
 *   TAU_BENCH_USER_MODEL=claude-sonnet-4-20250514  — model for user sim
 *   TAU_BENCH_USER_PROVIDER=anthropic              — litellm provider
 *
 * Requires setup first:
 *   bash benchmarks/tau-bench/setup.sh
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { scenario } from '../../src/scenario.js'
import { stateConsistent } from '../../src/invariants.js'
import { runTauBenchTask, type TauBenchOptions } from './adapter.js'
import type { ProfilerObserver } from '../../src/observer.js'

const VENV_PYTHON = resolve(import.meta.dirname, '.venv/bin/python')

export default scenario({
  description:
    'tau-bench multi-turn customer service benchmark: agent handles realistic retail/airline support tasks ' +
    'with tool-use, scored against ground-truth state mutations and required outputs.',
  stresses:
    'Multi-turn tool dispatch under conversational pressure. The agent must maintain coherent state across ' +
    'many turns with a simulated user, correctly sequencing lookups and mutations through domain-specific tools. ' +
    'Exercises the SDK agent loop over extended conversations (5-15 turns per task), tool_use/tool_result pairing ' +
    'integrity across many calls, and whether the SDK correctly relays tool results back into the conversation context.',
  dimensions: ['tool-dispatch', 'agent-loop', 'state-consistency'],
  evaluation: {
    rubric:
      'Each task scored binary (0 or 1) by tau-bench: checks whether the agent performed the correct ' +
      'state-modifying actions AND included required information in responses. Pass rate target: >= 40% ' +
      'with a capable model (tau-bench is deliberately hard). Per-task breakdown in invariants.',
  },
  run,
})

async function run(profiler: ProfilerObserver) {
  // Check that the venv is set up
  if (!existsSync(VENV_PYTHON)) {
    throw new Error('tau-bench not set up. Run: bash benchmarks/tau-bench/setup.sh')
  }

  // Configuration from env
  const envName = (process.env.TAU_BENCH_ENV ?? 'retail') as 'retail' | 'airline'
  const limit = Number(process.env.TAU_BENCH_LIMIT) || 5
  const userModel = process.env.TAU_BENCH_USER_MODEL ?? 'bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0'
  const userProvider = process.env.TAU_BENCH_USER_PROVIDER ?? 'bedrock'

  console.log(`[tau-bench] env=${envName}, limit=${limit}, user_model=${userModel}`)

  // Run tasks
  const results: Array<{ taskIndex: number; reward: number; done: boolean; turns: number; error?: string }> = []

  const taskCount = limit === 0 ? 200 : limit // 200 = reasonable upper bound for "all"

  for (let i = 0; i < taskCount; i++) {
    const options: TauBenchOptions = {
      envName,
      taskIndex: i,
      userModel,
      userProvider,
    }

    try {
      const result = await runTauBenchTask(profiler, options)
      results.push({ taskIndex: i, ...result })
      console.log(
        `[tau-bench] task ${i}: reward=${result.reward}, turns=${result.turns}, done=${result.done}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ taskIndex: i, reward: 0, done: false, turns: 0, error: message })
      console.log(`[tau-bench] task ${i}: ERROR — ${message}`)
    }
  }

  // Aggregate results
  const passCount = results.filter((r) => r.reward === 1).length
  const total = results.length
  const passRate = total > 0 ? passCount / total : 0
  const avgTurns = total > 0 ? results.reduce((sum, r) => sum + r.turns, 0) / total : 0
  const errors = results.filter((r) => r.error)
  const threshold = 0.4

  const breakdown = results
    .map((r) => {
      const status = r.error ? `ERROR: ${r.error.slice(0, 80)}` : r.reward === 1 ? 'PASS' : 'FAIL'
      return `  task ${r.taskIndex}: ${status} (${r.turns} turns)`
    })
    .join('\n')

  profiler.recordInvariants(
    stateConsistent(
      'tau-bench-pass-rate',
      passRate >= threshold,
      [
        `${passCount}/${total} (${(passRate * 100).toFixed(1)}%) passed; threshold=${(threshold * 100).toFixed(0)}%`,
        `avg turns: ${avgTurns.toFixed(1)}, errors: ${errors.length}`,
        '',
        'Per-task:',
        breakdown,
      ].join('\n'),
    ),
  )
}
