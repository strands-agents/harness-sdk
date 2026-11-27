import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planProjectPreparation } from '../../src/project/preparation-plan.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const project = async (language: 'typescript' | 'python') => {
  const root = await temporaryDirectory()
  const entrypoint = join(root, language === 'python' ? 'agent.py' : 'agent.ts')
  await writeFile(entrypoint, '')
  return { root, entrypoint, language }
}

describe('project preparation plans', () => {
  it('shouldInstallTheLocalPythonPackageAlongsideRequirementsWhenBothAreDeclared', async () => {
    const selected = await project('python')
    await writeFile(join(selected.root, 'requirements.txt'), 'dependency==1.2.3\n')
    await writeFile(
      join(selected.root, 'pyproject.toml'),
      '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n[project]\nname = "refund-desk"\nversion = "1.0.0"\nrequires-python = ">=3.11"\n'
    )
    await mkdir(join(selected.root, 'src/refund_desk'), { recursive: true })
    await writeFile(join(selected.root, 'src/refund_desk/__init__.py'), 'value = 1\n')

    const plan = await planProjectPreparation(selected)

    expect(plan.manager).toBe('pip')
    expect(plan.runtime).toContain('>=3.11')
    expect(plan.commands.flatMap(({ args }) => args)).not.toContain('--no-deps')
    expect(plan.commands.map(({ args }) => args)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['-r', 'requirements.txt']),
        expect.arrayContaining(['--editable', '.']),
      ])
    )
  })

  it('shouldUseFrozenUvSetupWhenTheProjectHasUvLock', async () => {
    const selected = await project('python')
    await writeFile(join(selected.root, 'pyproject.toml'), '[project]\nname = "refund-desk"\nversion = "1.0.0"\n')
    await writeFile(join(selected.root, 'uv.lock'), 'version = 1\n')

    expect((await planProjectPreparation(selected)).commands).toEqual([
      { command: 'uv', args: ['sync', '--locked', '--inexact'], stage: 'dependencies' },
    ])
    expect(await readFile(join(selected.root, 'uv.lock'), 'utf8')).toBe('version = 1\n')
  })

  it('shouldNotInstallTheProjectWhenPyprojectOnlyContainsToolSettings', async () => {
    const selected = await project('python')
    await writeFile(join(selected.root, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n')

    const plan = await planProjectPreparation(selected)

    expect(plan.commands).toHaveLength(1)
    expect(plan.guidance).toContain('No installable Python project')
  })

  it('shouldInstallDeclaredDependenciesWithoutGuessingWhenPyprojectIsNotPackaged', async () => {
    const selected = await project('python')
    await writeFile(
      join(selected.root, 'pyproject.toml'),
      '[project]\nname = "script"\ndependencies = ["requests==2.32.0"]\n'
    )

    const plan = await planProjectPreparation(selected)

    expect(plan.commands[1]?.args).toContain('requests==2.32.0')
    expect(plan.commands.flatMap(({ args }) => args)).not.toContain('--editable')
    expect(plan.guidance).toContain('no build-system')
  })

  it.each(['poetry.lock', 'Pipfile.lock'])('shouldExplainManualSetupWhenPythonLockfileIs%s', async (lock) => {
    const selected = await project('python')
    await writeFile(join(selected.root, lock), '')
    const plan = await planProjectPreparation(selected)
    expect(plan.manager).toBe('manual')
    expect(plan.commands).toEqual([])
    expect(plan.guidance).toContain(lock)
  })

  it.each([true, false])('shouldPlanNpmInstallAndBuildWhenLockfileExistsIs%s', async (locked) => {
    const selected = await project('typescript')
    await writeFile(
      join(selected.root, 'package.json'),
      JSON.stringify({ engines: { node: '>=22' }, scripts: { build: 'tsc' } })
    )
    if (locked) await writeFile(join(selected.root, 'package-lock.json'), '{}')

    const plan = await planProjectPreparation(selected)

    expect(plan.commands[0]?.args[0]).toBe(locked ? 'ci' : 'install')
    expect(plan.commands[0]?.args).toContain('--ignore-scripts')
    expect(plan.commands[1]).toEqual({ command: 'npm', args: ['--global=false', 'run', 'build'], stage: 'build' })
    if (!locked) expect(plan.commands[0]?.args).toContain('--package-lock=false')
  })

  it.each(['pnpm-lock.yaml', 'yarn.lock', 'bun.lock'])('shouldAvoidGuessingCommandsWhenNodeUses%s', async (lock) => {
    const selected = await project('typescript')
    await writeFile(join(selected.root, 'package.json'), '{}')
    await writeFile(join(selected.root, lock), '')
    expect((await planProjectPreparation(selected)).manager).toBe('manual')
  })

  it('shouldReportTheRequiredNodeVersionWhenTheRuntimeIsUnsupported', async () => {
    const selected = await project('typescript')
    await writeFile(join(selected.root, 'package.json'), '{"engines":{"node":"<10"}}')
    await expect(planProjectPreparation(selected)).rejects.toThrow('does not satisfy package.json engines.node')
  })
})
