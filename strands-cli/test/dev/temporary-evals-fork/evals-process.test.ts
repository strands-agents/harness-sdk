import { describe, expect, it } from 'vitest'

import { temporaryEvalsFailure } from '../../../src/dev/temporary-evals-fork/evals-process.js'

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
