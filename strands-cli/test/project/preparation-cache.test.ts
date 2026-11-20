import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executePreparation } from '../../src/project/preparation.js'
import { planProjectPreparation } from '../../src/project/preparation-plan.js'
import { cachedPreparation, preparationCacheState, savePreparationCache } from '../../src/project/preparation-cache.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const fixture = async () => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'agent.ts'), 'export const agent = {}')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'cache-fixture', version: '1.0.0', scripts: { build: 'node build.cjs' } })
  )
  await writeFile(
    join(root, 'build.cjs'),
    "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/agent.js',fs.readFileSync('agent.ts')); fs.appendFileSync('dist/runs','x')"
  )
  return { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const }
}

describe('reusable project preparation', () => {
  it('shouldSkipInstallAndBuildWhenTheProjectAndEnvironmentAreUnchanged', async () => {
    const project = await fixture()
    await executePreparation(await planProjectPreparation(project))
    const progress = vi.fn()

    const log = await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress).not.toHaveBeenCalled()
    expect(await readFile(join(project.root, 'dist/runs'), 'utf8')).toBe('x')
    expect(await readFile(log, 'utf8')).toContain('Reused unchanged project preparation')
  }, 30000)

  it('shouldRebuildWithoutInstallingWhenOnlySourceChanges', async () => {
    const project = await fixture()
    await executePreparation(await planProjectPreparation(project))
    await writeFile(project.entrypoint, 'export const agent = {name: "edited"}')
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
    expect(await readFile(join(project.root, 'dist/runs'), 'utf8')).toBe('xx')
  }, 30000)

  it('shouldInstallAgainWhenTheManifestChanges', async () => {
    const project = await fixture()
    await executePreparation(await planProjectPreparation(project))
    const path = join(project.root, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...manifest, description: 'changed' }))
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['dependencies', 'build'])
  }, 30000)

  it('shouldRebuildWhenAnOutputDirectoryIsRemoved', async () => {
    const project = await fixture()
    await executePreparation(await planProjectPreparation(project))
    await rm(join(project.root, 'dist'), { recursive: true })
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
  }, 30000)

  it('shouldRebuildWhenANestedBuildOutputIsRemoved', async () => {
    const project = await fixture()
    await executePreparation(await planProjectPreparation(project))
    await rm(join(project.root, 'dist/agent.js'))
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
    expect(await readFile(join(project.root, 'dist/agent.js'), 'utf8')).toContain('agent')
  }, 30000)

  it('shouldRebuildWhenTheBuildEnvironmentFileChanges', async () => {
    const project = await fixture()
    await writeFile(join(project.root, '.env.production'), 'ENDPOINT=first')
    await writeFile(
      join(project.root, 'build.cjs'),
      "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/value',fs.readFileSync('.env.production'))"
    )
    await executePreparation(await planProjectPreparation(project))
    await writeFile(join(project.root, '.env.production'), 'ENDPOINT=second')
    const progress = vi.fn()

    await executePreparation(await planProjectPreparation(project), { progress })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['build'])
    expect(await readFile(join(project.root, 'dist/value'), 'utf8')).toBe('ENDPOINT=second')
  }, 30000)

  it('shouldNotReuseBuildOutputsWhenTheyExceedTheFingerprintLimit', async () => {
    const project = await fixture()
    await mkdir(join(project.root, 'dist'))
    const output = join(project.root, 'dist/large.bin')
    await writeFile(output, '')
    await truncate(output, 33 * 1024 * 1024)
    const plan = await planProjectPreparation(project)
    const marker = join(project.root, 'prepared.json')
    await savePreparationCache(marker, await preparationCacheState(plan), '/tmp/log')

    expect((await cachedPreparation(marker, await preparationCacheState(plan))).build).toBe(false)
  })

  it('shouldInvalidateDependenciesWhenNestedRequirementsChange', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.py'), 'agent = None')
    await mkdir(join(root, 'requirements'))
    await writeFile(join(root, 'requirements.txt'), '-r requirements/base.txt\n')
    await writeFile(join(root, 'requirements/base.txt'), '-c constraints.txt\npackage==1.0\n')
    await writeFile(join(root, 'requirements/constraints.txt'), 'other==1.0\n')
    const plan = await planProjectPreparation({ root, entrypoint: join(root, 'agent.py'), language: 'python' })
    const before = await preparationCacheState(plan)

    await writeFile(join(root, 'requirements/constraints.txt'), 'other==2.0\n')
    const after = await preparationCacheState(plan)

    expect(after.dependencies).not.toBe(before.dependencies)
  })

  it('shouldDisableDependencyReuseWhenRequirementsIncludeARemoteFile', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.py'), 'agent = None')
    await writeFile(join(root, 'requirements.txt'), '-r https://example.test/requirements.txt\n')
    const plan = await planProjectPreparation({ root, entrypoint: join(root, 'agent.py'), language: 'python' })

    expect((await preparationCacheState(plan)).dependencies).toBeUndefined()
  })

  it('shouldForceRepairWhenRequestedAfterAnEntrypointFailure', async () => {
    const project = await fixture()
    const plan = await planProjectPreparation(project)
    await executePreparation(plan)
    const progress = vi.fn()

    await executePreparation(plan, { progress, force: true })

    expect(progress.mock.calls.map(([step]) => step.stage)).toEqual(['dependencies', 'build'])
  }, 30000)

  it('shouldInvalidateDependenciesWhenAnInstalledPackageDisappears', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.ts')
    await writeFile(entrypoint, 'export const agent = {}')
    await writeFile(join(root, 'package.json'), '{"dependencies":{"fixture-package":"1.0.0"}}')
    await mkdir(join(root, 'node_modules/fixture-package'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/fixture-package/package.json'),
      '{"name":"fixture-package","version":"1.0.0"}'
    )
    const plan = await planProjectPreparation({ root, entrypoint, language: 'typescript' })
    const marker = join(root, 'prepared.json')
    await savePreparationCache(marker, await preparationCacheState(plan), '/tmp/log')
    await rm(join(root, 'node_modules/fixture-package'), { recursive: true })

    expect((await cachedPreparation(marker, await preparationCacheState(plan))).dependencies).toBe(false)
  })

  it('shouldRejectAReplacedPythonEnvironmentEvenWhenTheManifestsMatch', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.py')
    await writeFile(entrypoint, 'agent = None')
    const executable = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const site = join(
      root,
      '.venv',
      process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.12/site-packages'
    )
    await mkdir(site, { recursive: true })
    await mkdir(join(executable, '..'), { recursive: true })
    await writeFile(executable, 'runtime-a')
    await writeFile(join(root, '.venv/pyvenv.cfg'), 'version = 3.12')
    const plan = await planProjectPreparation({ root, entrypoint, language: 'python' })
    const marker = join(root, 'prepared.json')
    await savePreparationCache(marker, await preparationCacheState(plan), '/tmp/log')
    await writeFile(executable, 'runtime-b-with-different-content')

    expect((await cachedPreparation(marker, await preparationCacheState(plan))).dependencies).toBe(false)
  })
})
