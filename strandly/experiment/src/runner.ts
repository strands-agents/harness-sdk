/**
 * Runner — loads and executes scenario files, captures results.
 */

import { readdir } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { ProfilerObserver } from './observer.js'
import { captureSourceVersion } from './source-version.js'
import type { Scenario } from './scenario.js'
import type { ScenarioResult, SuiteResult } from './types.js'

export interface ScenarioTranscript {
  name: string
  content: string
}

const SCENARIOS_DIR = resolve(import.meta.dirname, '../scenarios')

const DEFAULT_CONCURRENCY = 4

export interface SuiteRunResult {
  suite: SuiteResult
  transcripts: ScenarioTranscript[]
}

export async function runSuite(filter?: string, experiment = 'unnamed', dimension?: string, fast = false): Promise<SuiteRunResult> {
  const startTime = Date.now()
  let files = await findScenarios(filter)

  // --fast: keep only scenarios that use pure synthetic tools (no bash, no
  // filesystem access). These run in ~2 min total and can't hang.
  if (fast) {
    const { readFile } = await import('node:fs/promises')
    const kept: string[] = []
    for (const file of files) {
      const src = await readFile(file, 'utf-8')
      if (!src.includes("from '../../../strands-ts/src/vended-tools/bash")) kept.push(file)
    }
    files = kept
  }

  // When --dim is passed, load each scenario's metadata and keep only those
  // whose dimensions array contains the requested tag.
  if (dimension) {
    const matches: string[] = []
    for (const file of files) {
      try {
        const s = (await import(file)).default as Scenario
        if (s.dimensions.includes(dimension as never)) matches.push(file)
      } catch { /* skip unloadable */ }
    }
    files = matches
  }

  const concurrency = Number(process.env.CONCURRENCY) || DEFAULT_CONCURRENCY
  const results = await runParallel(files, concurrency)

  return {
    suite: {
      experiment,
      timestamp: new Date(startTime).toISOString(),
      totalDurationMs: Date.now() - startTime,
      sourceVersion: captureSourceVersion(),
      scenarios: results.map(r => r.scenario),
    },
    transcripts: results.map(r => r.transcript),
  }
}

interface ScenarioRunResult {
  scenario: ScenarioResult
  transcript: ScenarioTranscript
}

async function runParallel(files: string[], concurrency: number): Promise<ScenarioRunResult[]> {
  const results: ScenarioRunResult[] = new Array(files.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < files.length) {
      const idx = next++
      const file = files[idx]!
      console.log(`running: ${basename(file, '.ts')}`)
      results[idx] = await runScenario(file)
      console.log(`done:    ${basename(file, '.ts')}`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()))
  return results
}

async function runScenario(file: string): Promise<ScenarioRunResult> {
  const name = basename(file, '.ts')
  const startTime = Date.now()
  const errors: string[] = []

  const profiler = new ProfilerObserver()

  // Load metadata first so a crash inside run() still produces a labeled result.
  let scenario: Scenario | undefined
  try {
    scenario = (await import(file)).default as Scenario
  } catch (err) {
    errors.push(`failed to load scenario: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (scenario) {
    try {
      await scenario.run(profiler)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    scenario: {
      name,
      description: scenario?.description ?? '',
      stresses: scenario?.stresses ?? '',
      dimensions: scenario?.dimensions ?? [],
      ...(scenario?.evaluation && { evaluation: scenario.evaluation }),
      ...(profiler.invariants.length > 0 && { invariants: profiler.invariants }),
      durationMs: Date.now() - startTime,
      invocations: profiler.invocations,
      errors,
    },
    transcript: {
      name,
      content: profiler.transcript,
    },
  }
}

async function findScenarios(filter?: string): Promise<string[]> {
  const entries = await readdir(SCENARIOS_DIR)
  let files = entries
    .filter(f => f.endsWith('.ts'))
    .map(f => resolve(SCENARIOS_DIR, f))
    .sort()

  if (filter) {
    files = files.filter(f => basename(f).includes(filter))
  }

  return files
}
