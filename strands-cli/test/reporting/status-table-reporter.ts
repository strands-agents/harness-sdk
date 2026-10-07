import { relative } from 'node:path'

import type { Reporter, TestCase, TestModule, TestSpecification } from 'vitest/node'

export interface TestScenario {
  id: string
  description: string
  testName: string
}

interface Progress {
  id: string
  description: string
  state: TestState
  startedAt?: number
  duration?: number
  passed: number
  failed: number
  skipped: number
  total: number
}

type TestState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped'

interface StatusTableReporterOptions {
  suite: string
  scenarios?: readonly TestScenario[]
  target?: () => string
}

export default class StatusTableReporter implements Reporter {
  private readonly progress = new Map<string, Progress>()
  private readonly interactive = Boolean(process.stdout.isTTY)
  private readonly scenarioMode: boolean
  private renderedLines = 0
  private refreshTimer?: NodeJS.Timeout
  private runStartedAt = 0
  private failures: { name: string; errors: readonly unknown[] }[] = []

  constructor(private readonly options: StatusTableReporterOptions) {
    this.scenarioMode = options.scenarios !== undefined
    for (const scenario of options.scenarios ?? []) {
      this.progress.set(scenario.testName, progressFor(scenario.id, scenario.description))
    }
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    if (!this.scenarioMode) {
      for (const specification of specifications) {
        this.progress.set(specification.moduleId, progressFor(moduleName(specification.moduleId), 'Collecting tests'))
      }
    }
    this.runStartedAt = Date.now()
    this.refreshTimer = setInterval(() => this.render(), 1_000)
    this.refreshTimer.unref()
    this.render()
  }

  onTestModuleCollected(testModule: TestModule): void {
    if (this.scenarioMode) return
    const progress = this.progress.get(testModule.moduleId)
    if (!progress) return
    progress.total = [...testModule.children.allTests()].length
    progress.description = caseCount(progress)
  }

  onTestModuleStart(testModule: TestModule): void {
    if (this.scenarioMode) return
    const progress = this.progress.get(testModule.moduleId)
    if (!progress) return
    progress.state = 'running'
    progress.startedAt = Date.now()
    this.started(progress)
  }

  onTestModuleEnd(testModule: TestModule): void {
    if (this.scenarioMode) return
    const progress = this.progress.get(testModule.moduleId)
    if (!progress) return
    const state = testModule.state()
    progress.state = state === 'pending' ? 'running' : state
    progress.duration = testModule.diagnostic().duration
    progress.description = caseCount(progress)
    this.finished(progress)
  }

  onTestCaseReady(testCase: TestCase): void {
    if (!this.scenarioMode) return
    const progress = this.progress.get(testCase.name)
    if (!progress) return
    progress.state = 'running'
    progress.startedAt = Date.now()
    this.started(progress)
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    const progress = this.scenarioMode ? this.progress.get(testCase.name) : this.progress.get(testCase.module.moduleId)
    if (!progress) return
    if (!this.scenarioMode && result.state !== 'pending') {
      progress[result.state] += 1
    }
    if (this.scenarioMode) {
      progress.state = result.state === 'pending' ? 'running' : result.state
      const duration = testCase.diagnostic()?.duration
      if (duration !== undefined) {
        progress.duration = duration
      }
      this.finished(progress)
    }
    if (result.state === 'failed') {
      this.failures.push({ name: testCase.fullName, errors: result.errors })
    }
  }

  onTestRunEnd(_testModules: ReadonlyArray<TestModule>, unhandledErrors: ReadonlyArray<unknown>): void {
    clearInterval(this.refreshTimer)
    this.render(true)
    for (const failure of this.failures) {
      writeErrors(failure.name, failure.errors)
    }
    if (unhandledErrors.length > 0) {
      writeErrors('Unhandled test errors', unhandledErrors)
    }
  }

  private started(progress: Progress): void {
    if (this.interactive) {
      this.render()
    } else {
      process.stdout.write(`RUN  ${progress.id} · ${progress.description}\n`)
    }
  }

  private finished(progress: Progress): void {
    if (this.interactive) {
      this.render()
    } else {
      process.stdout.write(
        `${status(progress.state).padEnd(4)} ${progress.id} · ${formatDuration(progress.duration ?? 0)}\n`
      )
    }
  }

  private render(final = false): void {
    if (!this.interactive && !final && this.renderedLines > 0) return
    const elapsed = Date.now() - this.runStartedAt
    const allRows = [...this.progress.values()]
    const rows = visibleProgress(allRows, this.interactive && !final).map((progress) => [
      progress.id,
      progress.description,
      status(progress.state),
      latency(progress, elapsed),
    ])
    const target = this.options.target?.()
    const title = [this.options.suite, process.platform, target].filter(Boolean).join(' · ')
    const table = [
      title,
      drawTable(['Scenario', 'What it validates', 'Status', 'Latency'], rows),
      `${summary(allRows, this.scenarioMode)} · ${formatDuration(elapsed)}`,
    ].join('\n')

    if (this.interactive && this.renderedLines > 0) {
      process.stdout.write(`\u001b[${this.renderedLines}A\r\u001b[0J`)
    }
    process.stdout.write(`${table}\n`)
    this.renderedLines = table.split('\n').length
  }
}

function progressFor(id: string, description: string): Progress {
  return { id, description, state: 'queued', passed: 0, failed: 0, skipped: 0, total: 0 }
}

function moduleName(moduleId: string): string {
  const path = relative(process.cwd(), moduleId).replaceAll('\\', '/')
  return path.replace(/^test\//, '').replace(/\.test\.ts$/, '')
}

function caseCount(progress: Progress): string {
  const skipped = progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ''
  return `${progress.passed}/${progress.total} cases passed${skipped}`
}

function summary(progress: readonly Progress[], scenarioMode: boolean): string {
  if (scenarioMode) {
    const states = stateCounts(progress)
    return [
      `${states.passed} passed`,
      states.skipped > 0 ? `${states.skipped} skipped` : undefined,
      states.failed > 0 ? `${states.failed} failed` : undefined,
      `${progress.length} scenarios`,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  const passed = progress.reduce((total, entry) => total + entry.passed, 0)
  const skipped = progress.reduce((total, entry) => total + entry.skipped, 0)
  const failed = progress.reduce((total, entry) => total + entry.failed, 0)
  return [
    `${passed} passed`,
    skipped > 0 ? `${skipped} skipped` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    `${progress.length} files`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function stateCounts(progress: readonly Progress[]): Record<'passed' | 'failed' | 'skipped', number> {
  return {
    passed: progress.filter((entry) => entry.state === 'passed').length,
    failed: progress.filter((entry) => entry.state === 'failed').length,
    skipped: progress.filter((entry) => entry.state === 'skipped').length,
  }
}

function visibleProgress(progress: readonly Progress[], compact: boolean): readonly Progress[] {
  if (!compact) return progress
  const limit = Math.max(8, (process.stdout.rows ?? 30) - 8)
  if (progress.length <= limit) return progress
  const active = progress.filter((entry) => entry.state === 'running' || entry.state === 'failed')
  const remaining = progress.filter((entry) => !active.includes(entry))
  return [...active, ...remaining.slice(-Math.max(0, limit - active.length))]
}

function drawTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = [32, 38, 8, 9]
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

function status(state: TestState): string {
  return {
    queued: 'WAIT',
    running: 'RUN',
    passed: 'PASS',
    failed: 'FAIL',
    skipped: 'SKIP',
  }[state]
}

function latency(progress: Progress, elapsed: number): string {
  if (progress.duration !== undefined) return formatDuration(progress.duration)
  if (progress.startedAt !== undefined) return formatDuration(Date.now() - progress.startedAt)
  return elapsed === 0 ? '-' : 'pending'
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(1)} s`
}

function writeErrors(name: string, errors: readonly unknown[]): void {
  process.stderr.write(`\n${name}\n`)
  for (const error of errors) {
    process.stderr.write(`${errorText(error)}\n`)
  }
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
