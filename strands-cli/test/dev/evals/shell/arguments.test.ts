import { describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../../../../src/cli/arguments.js'
import { parseEvalsDevCommandArguments } from '../../../../src/dev/evals/shell/arguments.js'

describe('strands dev optimize arguments', () => {
  it('shouldParseTheExperimentWorkspaceAndEvalsFlagsWhenDevOptimizeIsCalled', () => {
    const parsed = parseArgs(['dev', 'optimize', 'support', '--workspace', 'desk', '--', '--tune', 'effort'])

    expect(parsed.dev).toMatchObject({
      init: false,
      workspace: 'desk',
      evalsCommand: { name: 'optimize', experiment: 'support', evalsArguments: ['--tune', 'effort'] },
    })
  })

  it('shouldRejectUnknownFlagsBeforeTheSeparatorWhenDevOptimizeIsCalled', () => {
    expect(() => parseArgs(['dev', 'optimize', '--tune', 'effort'])).toThrow()
  })

  it('shouldParseTheEvaluateCommandWhenDevEvaluateIsCalled', () => {
    const parsed = parseArgs(['dev', 'evaluate', 'refunds', '--', '--max-workers', '2'])

    expect(parsed.dev?.evalsCommand).toEqual({
      name: 'evaluate',
      experiment: 'refunds',
      evalsArguments: ['--max-workers', '2'],
    })
  })

  it.each(['optimize', 'evaluate'] as const)('shouldLabelTheCommandExperimentalWhenDev%sPrintsItsHelp', (name) => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(() => parseEvalsDevCommandArguments(name, ['--help'])).toThrow()
    const help = write.mock.calls.map(([text]) => String(text)).join('')
    write.mockRestore()

    expect(help).toContain('Experimental: ')
    expect(help).not.toContain('TEMPORARY')
  })

  it('shouldNameTheUpstreamCommandWhenDevOptimizePrintsItsHelp', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(() => parseEvalsDevCommandArguments('optimize', ['--help'])).toThrow()
    const help = write.mock.calls.map(([text]) => String(text)).join('')
    write.mockRestore()

    expect(help.replace(/\s+/gu, ' ')).toContain('Flags after -- go to strands-evals optimize run.')
  })
})
