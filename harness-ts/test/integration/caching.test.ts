/**
 * Prompt-caching regression check: a real multi-turn agent keeps reading its cached prefix.
 *
 * The harness enables caching by default. This pins that the default wiring actually caches end to end, so
 * a change that silently disables it (a flipped default, a broken `caching` -> `resolveModel`
 * handoff, a provider flag regression) fails here instead of shipping as a quiet cost/latency loss.
 * The default injector plugins (`todos`, `environment`) are enabled so the configuration matches
 * the real default that first surfaced the caching/injection interaction.
 *
 * The signal is wire-level and no offline test can observe it: cumulative cache reads reported by
 * the model must grow turn over turn. With caching off they stay flat at zero, so the margin is
 * large and the assertions are robust against the model's non-determinism. Reads (not writes) are
 * the signal because Bedrock's prompt cache persists server-side for a few minutes, so a warm
 * prefix from an earlier run can make the first turn read rather than write — but every turn still
 * re-reads the cached prefix, so cumulative reads grow either way.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildAgent } from './harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

// A large, byte-stable prefix pushes the cacheable region (system prompt + tool schemas) over the
// model's minimum-cacheable-prefix size. Below it Bedrock declines to write a cache point and the
// whole check would pass vacuously with zero caching. Only the size and its stability across turns
// matter, not the content.
const STABLE_PREFIX = (
  'You are an automated integration test agent operating under a fixed protocol. '.repeat(8) + '\n'
).repeat(40)

// Single-word answers keep the turns cheap and deterministic and give the model no reason to call a
// tool, so each turn is one clean model call whose cache usage is easy to reason about.
const TURNS = [
  'Reply with exactly the word: apple. Nothing else.',
  'Reply with exactly the word: banana. Nothing else.',
  'Reply with exactly the word: cherry. Nothing else.',
]

function cacheRead(agent: { metrics: { accumulatedUsage: { cacheReadInputTokens?: number } } }): number {
  return agent.metrics.accumulatedUsage.cacheReadInputTokens ?? 0
}

describe('caching', () => {
  let previous: string

  // The environment plugin discovers files against the process cwd, so each test runs in its own
  // temp directory (restored afterward), matching the rest of the integ suite.
  beforeEach(() => {
    previous = process.cwd()
    process.chdir(mkdtempSync(join(tmpdir(), 'strands-integ-')))
  })

  afterEach(() => {
    process.chdir(previous)
  })

  it('reads grow across turns', async () => {
    const agent = await buildAgent({
      instructions: STABLE_PREFIX,
      builtinPlugins: ['todos', 'environment'],
    })
    // A rendered todo makes the todos injector fold real content into every turn, so the run
    // exercises the injector-plus-caching path rather than an empty, no-op injection.
    agent.appState.set('todos', [
      { content: 'Answer each question', activeForm: 'Answering each question', status: 'in_progress' },
    ])

    const reads: number[] = []
    for (const turn of TURNS) {
      await agent.invoke(`${TESTING} ${turn}`)
      reads.push(cacheRead(agent))
    }

    // Cumulative reads must end non-zero (the prefix was cached and read back) and grow on every
    // turn (each later turn re-reads the cached prefix). With caching off they stay flat at zero.
    expect(
      reads[reads.length - 1],
      `prompt cache was never read back across ${TURNS.length} turns: ${reads}`
    ).toBeGreaterThan(0)
    for (let turn = 1; turn < reads.length; turn++) {
      expect(reads[turn], `cumulative cache reads did not grow every turn: ${reads}`).toBeGreaterThan(reads[turn - 1]!)
    }
  })
})
