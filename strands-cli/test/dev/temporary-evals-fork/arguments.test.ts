import { describe, expect, it, vi } from 'vitest'

import { parseArgs } from '../../../src/cli/arguments.js'
import { parseTemporaryDevCommandArguments } from '../../../src/dev/temporary-evals-fork/arguments.js'

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

  it.each(['optimize', 'test'] as const)('shouldLabelTheCommandExperimentalWhenDev%sPrintsItsHelp', (name) => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(() => parseTemporaryDevCommandArguments(name, ['--help'])).toThrow()
    const help = write.mock.calls.map(([text]) => String(text)).join('')
    write.mockRestore()

    expect(help).toContain('Experimental: ')
    expect(help).not.toContain('TEMPORARY')
  })

  it('shouldNameTheUpstreamCommandWhenDevOptimizePrintsItsHelp', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(() => parseTemporaryDevCommandArguments('optimize', ['--help'])).toThrow()
    const help = write.mock.calls.map(([text]) => String(text)).join('')
    write.mockRestore()

    expect(help.replace(/\s+/gu, ' ')).toContain('Flags after -- go to strands-evals optimize run.')
  })
})
