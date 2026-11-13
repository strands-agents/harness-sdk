import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executePreparation,
  preparationFailure,
  redactPreparationOutput,
  ProjectPreparationError,
} from '../../src/project/preparation.js'
import { planProjectPreparation } from '../../src/project/preparation-plan.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

afterEach(() => vi.unstubAllEnvs())

const fixture = async (build: string) => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'agent.ts'), 'export const agent = {}')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'setup-fixture', version: '1.0.0', scripts: { build: 'node build.cjs' } })
  )
  await writeFile(join(root, 'build.cjs'), build)
  return { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const }
}

describe('project preparation execution', () => {
  it('shouldInstallAndBuildWithoutCreatingALockWhenNoneWasDeclared', async () => {
    const project = await fixture("require('node:fs').writeFileSync('built.txt', 'built')")
    const source = await readFile(project.entrypoint, 'utf8')
    const progress = vi.fn()

    const log = await executePreparation(await planProjectPreparation(project), { progress })

    expect(await readFile(join(project.root, 'built.txt'), 'utf8')).toBe('built')
    expect(await readFile(project.entrypoint, 'utf8')).toBe(source)
    await expect(readFile(join(project.root, 'package-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(progress.mock.calls.map(([value]) => value.stage)).toEqual(['dependencies', 'build'])
    expect(await readFile(log, 'utf8')).toContain('npm --global=false run build')
  }, 30000)

  it('shouldKeepFailedBuildDetailsAndRedactCredentialsInItsLog', async () => {
    const project = await fixture("console.error('Build failed ' + process.env.TEST_API_KEY); process.exit(1)")
    vi.stubEnv('TEST_API_KEY', 'sensitive-value-12345')
    const plan = await planProjectPreparation(project)

    let failure: ProjectPreparationError | undefined
    try {
      await executePreparation(plan)
    } catch (error) {
      if (!(error instanceof ProjectPreparationError)) throw error
      failure = error
    }

    expect(failure?.failure.stage).toBe('build')
    expect(failure?.failure.action).toContain('Retry')
    expect(failure?.failure.command).toBe('npm --global=false run build')
    expect(failure?.failure.details).not.toContain('sensitive-value-12345')
    expect(await readFile(failure!.failure.logPath!, 'utf8')).toContain('[redacted]')
    expect(await readFile(failure!.failure.logPath!, 'utf8')).not.toContain('sensitive-value-12345')
  }, 30000)

  it('shouldKeepNpmInstallationLocalWhenGlobalDefaultsAreInherited', async () => {
    const project = await fixture("require('node:fs').writeFileSync('built.txt', 'local')")
    const outside = await temporaryDirectory()
    vi.stubEnv('npm_config_global', 'true')
    vi.stubEnv('npm_config_prefix', outside)
    vi.stubEnv('NPM_CONFIG_LOCATION', 'global')
    await writeFile(join(project.root, '.npmrc'), `global=true\nprefix=${outside}\n`)

    await executePreparation(await planProjectPreparation(project))

    expect(await readdir(outside)).toEqual([])
    expect(await readFile(join(project.root, 'built.txt'), 'utf8')).toBe('local')
  }, 30000)

  it('shouldRedactTheDisplayedCommandWhenACommandContainsCredentials', () => {
    const failure = preparationFailure(new Error('download failed'), {
      stage: 'dependencies',
      command: 'pip install https://user:review-secret@example.test/pkg.whl',
      logPath: '/tmp/setup.log',
    })

    expect(failure.command).not.toContain('review-secret')
    expect(failure.command).toContain('[redacted]')
  })

  it('shouldRejectAStalePreviewBeforeRunningCommands', async () => {
    const project = await fixture('')
    const plan = await planProjectPreparation(project)
    await writeFile(join(project.root, 'package.json'), '{}')

    await expect(executePreparation(plan)).rejects.toThrow('manifests changed')
    await expect(readFile(join(project.root, 'built.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shouldExplainLocalPackageInstallationWhenAnImportIsMissing', () => {
    const failure = preparationFailure(new Error("No module named 'refund_desk'"))
    expect(failure.action).toContain('project root')
    expect(failure.action).toContain('editable install')
    expect(failure.action).not.toContain('pip install refund_desk')
  })

  it('shouldRedactTokensAndAuthenticatedUrlsWithoutLosingTheError', () => {
    const output = redactPreparationOutput(
      'Failed https://user:password@packages.test/simple?token=abc123 API_KEY=secret-value',
      {}
    )
    expect(output).toContain('Failed')
    expect(output).not.toContain('password')
    expect(output).not.toContain('abc123')
    expect(output).not.toContain('secret-value')
  })
})
