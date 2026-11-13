import { describe, expect, it } from 'vitest'

import { spawnTemporaryEvals, temporaryEvalsFailure } from '../../../src/dev/temporary-evals-fork/evals-process.js'

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
