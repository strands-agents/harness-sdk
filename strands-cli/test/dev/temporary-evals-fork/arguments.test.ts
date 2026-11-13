import { describe, expect, it } from 'vitest'

import { parseArgs } from '../../../src/cli/arguments.js'

describe('TEMPORARY strands dev optimize arguments', () => {
  it('shouldParseTheExperimentWorkspaceAndForkFlagsWhenDevOptimizeIsCalled', () => {
    const parsed = parseArgs(['dev', 'optimize', 'support', '--workspace', 'desk', '--', '--tune', 'effort'])

    expect(parsed.dev).toMatchObject({
      init: false,
      workspace: 'desk',
      temporaryCommand: { name: 'optimize', experiment: 'support', forkArguments: ['--tune', 'effort'] },
    })
  })

  it('shouldRejectUnknownFlagsBeforeTheSeparatorWhenDevOptimizeIsCalled', () => {
    expect(() => parseArgs(['dev', 'optimize', '--tune', 'effort'])).toThrow()
  })

  it('shouldParseTheTestCommandWhenDevTestIsCalled', () => {
    const parsed = parseArgs(['dev', 'test', 'refunds', '--', '--max-workers', '2'])

    expect(parsed.dev?.temporaryCommand).toEqual({
      name: 'test',
      experiment: 'refunds',
      forkArguments: ['--max-workers', '2'],
    })
  })
})
