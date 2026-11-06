/**
 * Output formatting for run results.
 */

import type { SuiteResult, ScenarioResult, InvocationTrace, SourceVersion } from './types.js'
import type { RunSummary } from './store.js'

/** `list` command: one scannable row per saved run. */
export function formatRunList(runs: RunSummary[]): string {
  if (runs.length === 0) return 'no saved runs yet'

  const lines = runs.map(r => {
    const when = r.timestamp.replace('T', ' ').replace(/\..+Z$/, '')
    const code = `${r.sourceVersion.gitSha}${r.sourceVersion.gitDirty ? '*' : ''}`.padEnd(10)
    const name = r.name.padEnd(20)
    return `${name}  ${when}  ${code}  ${r.what}`
  })
  lines.push('', `runs are at: runs/<name>.json   transcripts at: runs/transcripts/<name>/   (* = dirty tree)`)
  return lines.join('\n')
}

export function formatSuiteResult(result: SuiteResult): string {
  const lines: string[] = []

  lines.push(`experiment: ${result.experiment}`)
  lines.push(`suite: ${result.scenarios.length} scenarios in ${formatMs(result.totalDurationMs)}`)
  lines.push(`code:  ${formatSourceVersion(result.sourceVersion)}`)
  lines.push('')

  for (const scenario of result.scenarios) {
    lines.push(formatScenario(scenario))
    lines.push('')
  }

  return lines.join('\n')
}


function formatScenario(scenario: ScenarioResult): string {
  const lines: string[] = []

  const cycles = scenario.invocations.reduce((s, i) => s + i.cycleCount, 0)
  const inTokens = scenario.invocations.reduce((s, i) => s + i.inputTokens, 0)
  const outTokens = scenario.invocations.reduce((s, i) => s + i.outputTokens, 0)

  lines.push(`[${scenario.name}] ${formatMs(scenario.durationMs)}  ${cycles} cycles  ${inTokens} in / ${outTokens} out`)

  // SDK invariants are the headline — deterministic, model-independent signal.
  if (scenario.invariants?.length) {
    const label = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' } as const
    for (const inv of scenario.invariants) {
      lines.push(`  invariant ${label[inv.status]}  ${inv.name} — ${inv.detail}`)
    }
  }

  if (scenario.errors.length > 0) {
    for (const err of scenario.errors) {
      lines.push(`  ERROR: ${err}`)
    }
  }

  for (const inv of scenario.invocations) {
    lines.push(formatInvocation(inv))
  }

  return lines.join('\n')
}

function formatInvocation(inv: InvocationTrace): string {
  const lines: string[] = []
  const inputPreview = inv.input.length > 80 ? inv.input.slice(0, 77) + '...' : inv.input

  lines.push(`  "${inputPreview}"`)
  lines.push(`    ${inv.cycleCount} cycles  ${inv.inputTokens} in / ${inv.outputTokens} out  stop=${inv.stopReason}  ${inv.messageCountAfter} msgs  ${formatMs(inv.durationMs)}`)

  // Cache only shown when nonzero — keeps the line quiet when caching is off.
  const cache = inv.cacheReadTokens || inv.cacheWriteTokens
    ? `  cache ${inv.cacheReadTokens}r/${inv.cacheWriteTokens}w`
    : ''
  lines.push(`    ctx ${inv.contextSize} tok  model ${formatMs(inv.modelLatencyMs)}${cache}`)

  for (const tc of inv.toolCalls) {
    const status = tc.success ? 'ok' : `err: ${tc.error}`
    lines.push(`    -> ${tc.name} ${formatMs(tc.durationMs)} ${tc.resultSize}ch [${status}]`)
  }

  return lines.join('\n')
}

function formatSourceVersion(p: SourceVersion): string {
  return `${p.gitSha}${p.gitDirty ? '-dirty' : ''}`
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '         -'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

