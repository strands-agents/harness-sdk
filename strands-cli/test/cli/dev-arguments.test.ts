import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'

const helpOf = (argv: string[]): string => {
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    expect(() => parseArgs(argv)).toThrow()
    return output.mock.calls.map(([chunk]) => String(chunk)).join('')
  } finally {
    output.mockRestore()
  }
}

describe('dev help', () => {
  it.each<[string, string[], string, string[]]>([
    [
      'Dev',
      ['dev', '--help'],
      'Chat with the agent of a local harness workspace.',
      ['  init ', '  evaluate [experiment] ', '  optimize [experiment] '],
    ],
    ['DevInit', ['dev', 'init', '--help'], 'Set up a local harness workspace, then exit', []],
  ])('shouldDescribeTheCommandAndListItsSubcommandsWhenTheHelpOf%sIsShown', (_case, argv, description, commands) => {
    const help = helpOf(argv)

    expect(help).toContain(description)
    expect(help).not.toContain('Chat with a Strands harness agent.')
    expect(help).not.toContain('TEMPORARY')
    expect(commands.filter((command) => !help.includes(command))).toEqual([])
  })

  it.each<[string, string[], string[]]>([
    ['Dev', ['dev', '--help'], ['--acp-server', '--setup']],
    [
      'DevInit',
      ['dev', 'init', '--help'],
      ['--acp-server', '--setup', '--print', '--prompt', '[request]', 'Arguments:'],
    ],
  ])('shouldHideWhatTheCommandRejectsWhenTheHelpOf%sIsShown', (_case, argv, rejected) => {
    const help = helpOf(argv)

    expect(rejected.filter((text) => help.includes(text))).toEqual([])
  })

  it('shouldKeepTheServerAndRequestOptionsWhenThePlainHelpIsShown', () => {
    const shown = ['Chat with a Strands harness agent.', '--acp-server', '--setup', '--print', '--prompt', '[request]']

    const help = helpOf(['--help'])

    expect(shown.filter((text) => !help.includes(text))).toEqual([])
  })
})

describe('dev arguments', () => {
  it('shouldSelectDevWhenTheIngressIsDev', () => {
    expect(parseArgs(['dev']).dev).toEqual({ init: false, workspace: undefined, searchRoots: [], create: undefined })
    expect(parseArgs(['hello']).dev).toBeUndefined()
    expect(parseArgs(['hello']).request).toBe('hello')
  })

  it('shouldKeepSelectionLocalWhenExplicitPathsAreProvided', () => {
    const args = parseArgs([
      'dev',
      '--workspace',
      './work',
      '--agent',
      './agent.py',
      '--search-root',
      '../one',
      '--search-root',
      '../two',
      '-p',
      'hello',
    ])

    expect(args).toMatchObject({
      agent: './agent.py',
      request: 'hello',
      oneShot: true,
      dev: { workspace: './work', searchRoots: ['../one', '../two'] },
    })
  })

  it.each(['cli', 'typescript', 'python'])('shouldSelectCreationWhenTheLanguageIs%s', (language) => {
    expect(parseArgs(['dev', 'init', '--create', language]).dev).toMatchObject({ init: true, create: language })
  })

  it.each<[string, string[], Record<string, unknown>]>([
    [
      'Evaluate',
      ['dev', '--workspace', 'desk', 'evaluate', 'refunds'],
      { workspace: 'desk', temporaryCommand: { name: 'evaluate', experiment: 'refunds', forkArguments: [] } },
    ],
    [
      'Optimize',
      ['dev', '--workspace=desk', 'optimize', 'support', '--', '--tune', 'effort'],
      {
        workspace: 'desk',
        temporaryCommand: { name: 'optimize', experiment: 'support', forkArguments: ['--tune', 'effort'] },
      },
    ],
    [
      'Init',
      ['dev', '--workspace', 'desk', 'init', '--create', 'cli'],
      { init: true, workspace: 'desk', create: 'cli' },
    ],
  ])('shouldRunThe%sSubcommandWhenOptionsComeBeforeIt', (_case, argv, expected) => {
    expect(parseArgs(argv).dev).toMatchObject(expected)
  })

  it.each<[string, string[], Record<string, unknown>]>([
    ['AnOptionValue', ['dev', '--prompt', 'test'], { request: 'test', dev: { init: false, workspace: undefined } }],
    [
      'TheWorkspaceName',
      ['dev', '--workspace', 'init'],
      { request: undefined, dev: { init: false, workspace: 'init' } },
    ],
    ['AfterTheSeparator', ['dev', '--', 'optimize'], { request: 'optimize', dev: { init: false } }],
  ])('shouldKeepASubcommandNameAsTextWhenItIs%s', (_case, argv, expected) => {
    const args = parseArgs(argv)

    expect(args).toMatchObject(expected)
    expect(args.dev?.temporaryCommand).toBeUndefined()
  })

  it.each([
    ['dev', '--create', 'ruby'],
    ['dev', '--create', 'cli', '--agent', 'agent.ts'],
    ['dev', '--setup'],
    ['dev', '--acp-server'],
    ['dev', 'init', '-p', 'hello'],
    ['--workspace', './work'],
  ])('shouldRejectInvalidDevArgumentsWhenArgsAre%s', (...args) => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      expect(() => parseArgs(args)).toThrow()
    } finally {
      output.mockRestore()
    }
  })
})
