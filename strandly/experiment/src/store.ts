import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SuiteResult } from './types.js'
import type { ScenarioTranscript } from './runner.js'

const RUNS_DIR = resolve(import.meta.dirname, '../runs')
const TRANSCRIPTS_DIR = resolve(RUNS_DIR, 'transcripts')

/**
 * Save a run under its experiment name. The caller is responsible for
 * checking that the name doesn't already exist before calling this.
 */
export async function save(result: SuiteResult, transcripts?: ScenarioTranscript[]): Promise<string> {
  const name = result.experiment
  await mkdir(RUNS_DIR, { recursive: true })
  const path = resolve(RUNS_DIR, `${name}.json`)
  await writeFile(path, JSON.stringify(result, null, 2))

  const tDir = resolve(TRANSCRIPTS_DIR, name)
  await rm(tDir, { recursive: true, force: true })
  if (transcripts?.length) {
    await mkdir(tDir, { recursive: true })
    for (const t of transcripts) {
      await writeFile(resolve(tDir, `${t.name}.txt`), t.content)
    }
  }

  return path
}

export async function load(name: string): Promise<SuiteResult> {
  const path = resolve(RUNS_DIR, `${name}.json`)
  const content = await readFile(path, 'utf-8')
  return JSON.parse(content)
}

export async function exists(name: string): Promise<boolean> {
  try {
    await readFile(resolve(RUNS_DIR, `${name}.json`))
    return true
  } catch {
    return false
  }
}

export interface RunSummary {
  name: string
  experiment: string
  timestamp: string
  sourceVersion: { gitSha: string; gitDirty: boolean }
  what: string
}

export async function listSummaries(): Promise<RunSummary[]> {
  await mkdir(RUNS_DIR, { recursive: true })
  const files = (await readdir(RUNS_DIR)).filter(f => f.endsWith('.json')).sort()
  const summaries: RunSummary[] = []
  for (const f of files) {
    const name = f.replace(/\.json$/, '')
    const r = await load(name)
    summaries.push({
      name,
      experiment: r.experiment,
      timestamp: r.timestamp,
      sourceVersion: r.sourceVersion,
      what: r.scenarios.length === 1 ? r.scenarios[0]!.name : `${r.scenarios.length} scenarios`,
    })
  }
  return summaries
}
