import type { Reporter, TestCase } from 'vitest/node'

import { TUI_CASES, type TuiIntegrationCase } from './catalog.js'

type CaseState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped'

interface CaseProgress {
  definition: TuiIntegrationCase
  state: CaseState
  startedAt?: number
  duration?: number
}

export default class TuiIntegrationReporter implements Reporter {
  private readonly progress = new Map<string, CaseProgress>(
    TUI_CASES.map((definition) => [definition.testName, { definition, state: 'queued' }])
  )
  private readonly interactive = Boolean(process.stdout.isTTY)
  private renderedLines = 0
  private refreshTimer?: NodeJS.Timeout
  private runStartedAt = 0
  private failures: { name: string; errors: readonly unknown[] }[] = []

  onTestRunStart(): void {
    this.runStartedAt = Date.now()
    this.refreshTimer = setInterval(() => this.render(), 1_000)
    this.refreshTimer.unref()
    this.render()
  }

  onTestCaseReady(testCase: TestCase): void {
    const progress = this.progress.get(testCase.name)
    if (!progress) return
    progress.state = 'running'
    progress.startedAt = Date.now()
    if (this.interactive) {
      this.render()
    } else {
      process.stdout.write(`RUN  ${progress.definition.id} · ${progress.definition.description}\n`)
    }
  }

  onTestCaseResult(testCase: TestCase): void {
    const progress = this.progress.get(testCase.name)
    if (!progress) return
    const result = testCase.result()
    progress.state = result.state === 'pending' ? 'running' : result.state
    const duration = testCase.diagnostic()?.duration
    if (duration !== undefined) {
      progress.duration = duration
    }
    if (result.state === 'failed') {
      this.failures.push({ name: testCase.fullName, errors: result.errors })
    }
    if (this.interactive) {
      this.render()
    } else {
      process.stdout.write(
        `${status(progress.state).padEnd(4)} ${progress.definition.id} · ${formatDuration(progress.duration ?? 0)}\n`
      )
    }
  }

  onTestRunEnd(): void {
    clearInterval(this.refreshTimer)
    this.render(true)
    for (const failure of this.failures) {
      process.stderr.write(`\n${failure.name}\n`)
      for (const error of failure.errors) {
        process.stderr.write(`${errorText(error)}\n`)
      }
    }
  }

  private render(final = false): void {
    if (!this.interactive && !final && this.renderedLines > 0) {
      return
    }
    const target = process.env.STRANDS_CLI_TEST_DIST === 'true' ? 'compiled' : 'source'
    const elapsed = Date.now() - this.runStartedAt
    const rows = [...this.progress.values()].map((progress) => [
      progress.definition.id,
      progress.definition.description,
      status(progress.state),
      latency(progress, elapsed),
    ])
    const passed = rows.filter((row) => row[2] === 'PASS').length
    const table = [
      `TUI integration · ${process.platform} · ${target}`,
      drawTable(['Scenario', 'What it validates', 'Status', 'Latency'], rows),
      `${passed}/${rows.length} passed · ${formatDuration(elapsed)}`,
    ].join('\n')

    if (this.interactive && this.renderedLines > 0) {
      process.stdout.write(`\u001b[${this.renderedLines}A\r\u001b[0J`)
    }
    process.stdout.write(`${table}\n`)
    this.renderedLines = table.split('\n').length
  }
}

function drawTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = [14, 49, 8, 9]
  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`
  const row = (values: readonly string[]): string =>
    `│ ${values.map((value, index) => fit(value, widths[index]!)).join(' │ ')} │`
  return [border('┌', '┬', '┐'), row(headers), border('├', '┼', '┤'), ...rows.map(row), border('└', '┴', '┘')].join(
    '\n'
  )
}

function fit(value: string, width: number): string {
  const truncated = value.length > width ? `${value.slice(0, width - 1)}…` : value
  return truncated.padEnd(width)
}

function status(state: CaseState): string {
  return {
    queued: 'WAIT',
    running: 'RUN',
    passed: 'PASS',
    failed: 'FAIL',
    skipped: 'SKIP',
  }[state]
}

function latency(progress: CaseProgress, elapsed: number): string {
  if (progress.duration !== undefined) return formatDuration(progress.duration)
  if (progress.startedAt !== undefined) return formatDuration(Date.now() - progress.startedAt)
  return elapsed === 0 ? '-' : 'pending'
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(1)} s`
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  if (error && typeof error === 'object') {
    const value = error as { stack?: unknown; message?: unknown }
    if (typeof value.stack === 'string') return value.stack
    if (typeof value.message === 'string') return value.message
  }
  return String(error)
}
