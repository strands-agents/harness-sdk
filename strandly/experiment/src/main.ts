import { resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { runSuite } from './runner.js'
import { formatSuiteResult, formatRunList } from './output.js'
import { save, exists, listSummaries } from './store.js'

const RUNS_DIR = resolve(import.meta.dirname, '../runs')

// Pull named flags out of argv; the rest are positional.
const raw = process.argv.slice(2)
function extractFlag(arr: string[], flag: string): { value: string | undefined; rest: string[] } {
  const idx = arr.indexOf(flag)
  if (idx < 0) return { value: undefined, rest: arr }
  return { value: arr[idx + 1], rest: arr.filter((_, i) => i !== idx && i !== idx + 1) }
}
const { value: experiment, rest: r1 } = extractFlag(raw, '--as')
const { value: dimension, rest: r2 } = extractFlag(r1, '--dim')
const fast = r2.includes('--fast')
const args = fast ? r2.filter(a => a !== '--fast') : r2
const command = args[0]

if (command === 'dims') {
  const { readdir: rd } = await import('node:fs/promises')
  const { resolve: res, basename: bn } = await import('node:path')
  const dir = res(import.meta.dirname, '../scenarios')
  const entries = (await rd(dir)).filter(f => f.endsWith('.ts')).sort()
  const dimMap: Record<string, string[]> = {}
  for (const f of entries) {
    const s = (await import(res(dir, f))).default as { dimensions?: string[] }
    for (const d of s.dimensions ?? []) {
      ;(dimMap[d] ??= []).push(bn(f, '.ts'))
    }
  }
  for (const [d, scenarios] of Object.entries(dimMap).sort()) {
    console.log(`${d.padEnd(22)} ${scenarios.join(', ')}`)
  }
} else if (command === 'list') {
  console.log(formatRunList(await listSummaries()))
} else if (command === 'transcript') {
  const runName = args[1]
  const scenarioFilter = args[2]
  if (!runName) { console.error('usage: run.sh transcript <name> [scenario-substring]'); process.exit(1) }
  if (!(await exists(runName))) { console.error(`no run named "${runName}" (try: run.sh list)`); process.exit(1) }
  const dir = resolve(RUNS_DIR, 'transcripts', runName)
  const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.txt'))
  if (files.length === 0) { console.error(`no transcripts for run "${runName}"`); process.exit(1) }
  const matching = scenarioFilter ? files.filter(f => f.includes(scenarioFilter)) : files
  if (matching.length === 0) { console.error(`no transcript matching "${scenarioFilter}" in run "${runName}" (available: ${files.map(f => f.replace('.txt', '')).join(', ')})`); process.exit(1) }
  for (const f of matching) {
    if (matching.length > 1) console.log(`\n=== ${f.replace('.txt', '')} ===\n`)
    console.log(await readFile(resolve(dir, f), 'utf-8'))
  }
} else {
  if (!experiment) {
    console.error('error: --as <name> is required. Name your run so you can refer to it later.')
    console.error('  example: bash run.sh --as baseline')
    console.error('  example: bash run.sh --as my-change')
    process.exit(1)
  }
  if (await exists(experiment)) {
    console.error(`error: a run named "${experiment}" already exists. Pick a different name or delete it first:`)
    console.error(`  rm runs/${experiment}.json && rm -rf runs/transcripts/${experiment}`)
    process.exit(1)
  }
  const filter = command === 'run' ? args[1] : command
  const { suite, transcripts } = await runSuite(filter ?? undefined, experiment, dimension, fast)
  const path = await save(suite, transcripts)
  console.log(formatSuiteResult(suite))
  console.log(`\nsaved: ${path}`)
}
