import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  spawnTemporaryEvals,
  temporaryEvalsFailure,
  temporaryRunName,
  temporaryRunNameParts,
} from '../../../src/dev/temporary-evals-fork/evals-process.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

describe('TEMPORARY run names', () => {
  it('shouldReadTheStartTimeAndExperimentBackWhenARunNameIsParsed', () => {
    const name = temporaryRunName('/w/strands-dev/tmp/experiments/refund-desk.json', new Date('2026-11-16T22:05:10Z'))

    expect(temporaryRunNameParts(name)).toEqual({
      startedAt: Date.parse('2026-11-16T22:05:10Z'),
      experiment: 'refund-desk',
    })
  })

  it.each(['.venv', '20261116-2205-refunds', 'refunds'])('shouldNotParse%sAsARunName', (name) => {
    expect(temporaryRunNameParts(name)).toBeUndefined()
  })
})

describe('TEMPORARY strands-evals failures', () => {
  it.each([
    { tail: ['progress', 'strands-evals: error: the record is in use'], headline: 'the record is in use' },
    {
      tail: ['strands-evals optimize: error: unrecognized arguments: --bogus'],
      headline: 'unrecognized arguments: --bogus',
    },
    { tail: ['Traceback (most recent call last):', 'KeyError: cases'], headline: 'KeyError: cases' },
    { tail: [], headline: 'it printed no error' },
  ])('shouldLeadWithTheReportedErrorWhenTheCommandFails ($headline)', ({ tail, headline }) => {
    const error = temporaryEvalsFailure(
      'strands-evals optimize',
      { code: 2, stdout: '', stderrTail: tail },
      {},
      'Next.'
    )

    expect(error.message).toBe(`strands-evals optimize stopped with exit code 2: ${headline}\nNext.`)
  })
})

describe.skipIf(process.platform === 'win32')('spawnTemporaryEvals', () => {
  it('shouldStopTheProcessAtOnceWhenItWasCancelledBeforeItStarted', async () => {
    const stop = new AbortController()
    stop.abort()
    const started = Date.now()

    const exit = await spawnTemporaryEvals({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 20000)'],
      cwd: process.cwd(),
      env: process.env,
      signal: stop.signal,
      onLine: () => undefined,
    })

    expect(exit.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

const evalsProcessModule = new URL('../../../src/dev/temporary-evals-fork/evals-process.ts', import.meta.url).href

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('spawnTemporaryEvals detached', () => {
  it('shouldKeepADetachedRunGoingAfterTheProcessThatStartedItExits', async () => {
    const folder = await temporaryDirectory()
    const marker = join(folder, 'finished')
    const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 1500)`
    const script = `const { spawnTemporaryEvals } = await import(${JSON.stringify(evalsProcessModule)})
void spawnTemporaryEvals({
  command: process.execPath,
  args: ['-e', ${JSON.stringify(child)}],
  cwd: ${JSON.stringify(folder)},
  env: process.env,
  log: ${JSON.stringify(join(folder, 'run.log'))},
  background: true,
  detached: true,
  onSpawn: () => process.exit(0),
  onLine: () => undefined,
})`
    const starter = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: 'ignore',
    })

    expect(await new Promise((resolve) => starter.once('exit', resolve))).toBe(0)

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 })
  })

  it('shouldWriteTheOutputToTheLogAndReportTheExitCodeOfADetachedRun', async () => {
    const folder = await temporaryDirectory()
    const log = join(folder, 'run.log')
    const lines: string[] = []

    const exit = await spawnTemporaryEvals({
      command: process.execPath,
      args: ['-e', "console.error('first'); console.error('boom'); process.exit(3)"],
      cwd: folder,
      env: process.env,
      log,
      background: true,
      detached: true,
      onLine: (line) => lines.push(line),
    })

    expect(exit).toEqual({ code: 3, stdout: '', stderrTail: ['first', 'boom'] })
    expect(await readFile(log, 'utf8')).toBe('first\nboom\n')
    expect(lines).toEqual(['first', 'boom'])
  })

  it('shouldStopEveryProcessOfADetachedRunWhenItIsCancelled', async () => {
    const folder = await temporaryDirectory()
    const stop = new AbortController()
    const helper = `const { spawn } = require('node:child_process')
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
console.error(String(helper.pid))
setTimeout(() => {}, 30000)`
    let helperPid = 0

    const exit = await spawnTemporaryEvals({
      command: process.execPath,
      args: ['-e', helper],
      cwd: folder,
      env: process.env,
      log: join(folder, 'run.log'),
      background: true,
      detached: true,
      signal: stop.signal,
      onLine: (line) => {
        helperPid = Number(line)
        stop.abort()
      },
    })

    expect(exit.code).not.toBe(0)
    expect(helperPid).toBeGreaterThan(0)
    await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 10_000 })
  })
})
