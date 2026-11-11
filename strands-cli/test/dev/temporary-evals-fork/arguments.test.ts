import { describe, expect, it } from 'vitest'

import { parseArgs } from '../../../src/cli/arguments.js'

describe('TEMPORARY strands dev optimize arguments', () => {
  it('shouldParseTheExperimentWorkspaceAndForkFlagsWhenDevOptimizeIsCalled', () => {
    const parsed = parseArgs(['dev', 'optimize', 'support', '--workspace', 'desk', '--', '--tune', 'effort'])

    expect(parsed.dev).toMatchObject({
      init: false,
      workspace: 'desk',
      temporaryOptimize: { experiment: 'support', forkArguments: ['--tune', 'effort'] },
    })
  })

  it('shouldRejectUnknownFlagsBeforeTheSeparatorWhenDevOptimizeIsCalled', () => {
    expect(() => parseArgs(['dev', 'optimize', '--tune', 'effort'])).toThrow()
  })
})
