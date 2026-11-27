import { describe, expect, it } from 'vitest'
import { devFailure, DevFailure } from '../../src/dev/errors.js'

describe('dev failure messages', () => {
  it('shouldExplainMissingAgentPathsWhenOpeningFails', () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, stat '/work/agent.ts'"), {
      code: 'ENOENT',
      path: '/work/agent.ts',
    })

    const message = devFailure(error, { operation: 'open' }).message

    expect(message).toContain('Agent file not found.')
    expect(message).toContain('Path: /work/agent.ts')
    expect(message).toContain('Next: Restore the missing path')
    expect(message).not.toContain('still active')
  })

  it('shouldExplainDependencyFailuresWhenTheInstallerFails', () => {
    const underlying = new Error(
      'Command failed: npm install\nnpm error code E404\nnpm error 404 Not Found: missing-package\n    at installer'
    )
    const error = new Error("Could not install the agent's dependencies.", { cause: underlying })

    const message = devFailure(error, { operation: 'install', path: '/work/project' }).message

    expect(message).toContain('Agent dependency setup failed.')
    expect(message).toContain('Path: /work/project')
    expect(message).toContain('npm error')
    expect(message).toContain('Next: Check the dependency files')
    expect(message).not.toContain('at installer')
  })

  it('shouldIdentifyTheSourceErrorWhenAgentLoadingFails', () => {
    const error = new SyntaxError('Unexpected token in agent.ts\n    at moduleLoad\n    at async bootstrap')

    const message = devFailure(error, { operation: 'load', path: '/work/agent.ts' }).message

    expect(message).toContain('Agent could not start.')
    expect(message).toContain('Unexpected token in agent.ts')
    expect(message).toContain('Next: Fix the reported source')
    expect(message).not.toContain('at moduleLoad')
  })

  it('shouldExplainBuildFailuresWithoutStackOutputWhenCompilationFails', () => {
    const source = new Error('Build failed\nerror TS2307: Cannot find module local-tool\n    at compiler')

    const message = devFailure(source, { operation: 'build', path: '/work/agent.ts' }).message

    expect(message).toContain('Agent build failed.')
    expect(message).toContain('error TS2307: Cannot find module local-tool')
    expect(message).toContain('Next: Fix the build error and rebuild the agent')
    expect(message).not.toContain('at compiler')
  })

  it('shouldSuggestInstallingDependenciesWhenAModuleCannotBeLoaded', () => {
    const error = Object.assign(new Error("Cannot find package 'my-model'"), { code: 'ERR_MODULE_NOT_FOUND' })

    const message = devFailure(error, { operation: 'load', path: '/work/agent.ts' }).message

    expect(message).toContain('Agent dependency missing.')
    expect(message).toContain('Path: /work/agent.ts')
    expect(message).toContain('Next: Install the project dependencies')
  })

  it('shouldConfirmTheOldSessionSurvivesWhenReloadFails', () => {
    const message = devFailure(new SyntaxError('Unexpected token'), {
      operation: 'reload',
      path: '/work/agent.ts',
    }).message

    expect(message).toContain('Agent reload failed.')
    expect(message).toContain('The previous working agent and session are still active.')
    expect(message).toContain('save again to retry')
  })

  it('shouldKeepTheOriginalCauseWhenFailureIsAlreadyFormatted', () => {
    const source = new Error('source failed')
    const failure = devFailure(source, { operation: 'load', path: '/work/agent.ts' })

    expect(failure).toBeInstanceOf(DevFailure)
    expect(failure.cause).toBe(source)
    expect(devFailure(failure, { operation: 'open' })).toBe(failure)
  })

  it('shouldRemoveTerminalEscapeSequencesWhenPathsOrReasonsContainThem', () => {
    const message = devFailure(new Error('\u001b[31mfailed\u001b[0m'), {
      operation: 'open',
      path: '\u001b[31m/work/agent.ts\u001b[0m',
    }).message

    expect(message).not.toContain('\u001b')
    expect(message).toContain('/work/agent.ts')
  })
})
