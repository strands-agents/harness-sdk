import { describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'

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
