import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { withDevModuleFiles } from '../../src/dev/module-files.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const fixture = async (source: string) => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'model.mjs'), source)
  const profile = defineHarnessAgentConfig({ modelModule: { kind: 'model', module: './model.mjs', export: 'model' } })
  return { root, profile }
}

describe('withDevModuleFiles', () => {
  it('shouldCollectOnlyStaticLocalImportsWhenFilesAreOmitted', async () => {
    const { root, profile } = await fixture("import { value } from './helper.mjs'\nexport const model = {value}\n")
    await writeFile(join(root, 'helper.mjs'), "export { value } from './value.mjs'\n")
    await writeFile(join(root, 'value.mjs'), 'export const value = 7\n')
    await writeFile(join(root, 'unrelated.mjs'), 'throw new Error("never copy")\n')

    const result = await withDevModuleFiles(profile, root, 'typescript')

    expect(result.modelModule?.files).toEqual([
      join(root, 'model.mjs'),
      join(root, 'helper.mjs'),
      join(root, 'value.mjs'),
    ])
    expect(profile.modelModule?.files).toBeUndefined()
  })

  it('shouldPinAResolvedDependencyWhenTheLocalModelImportsAPackage', async () => {
    const { root, profile } = await fixture(
      "import { createHarness } from '@strands-agents/harness'\nexport const model = createHarness\n"
    )

    const result = await withDevModuleFiles(profile, root, 'typescript')

    expect(result.dependencies.typescript['@strands-agents/harness']).toMatch(/^\d+\.\d+\.\d+/)
    expect(profile.dependencies.typescript).toEqual({})
  })

  it('shouldLeaveExplicitFilesUntouchedWhenTheUserAlreadyDeclaredThem', async () => {
    const { root, profile } = await fixture('export const model = 1\n')
    profile.modelModule!.files = ['./model.mjs']

    expect(await withDevModuleFiles(profile, root, 'typescript')).toEqual(profile)
  })

  it.each(['import(name)', 'require(name)'])('shouldRejectDynamicImportsWhenSourceContains%s', async (expression) => {
    const { root, profile } = await fixture(`export const model = ${expression}\n`)

    await expect(withDevModuleFiles(profile, root, 'typescript')).rejects.toThrow('Declare its files explicitly')
  })

  it('shouldRejectLinkedSourceWhenTheReferencedFileIsASymlink', async () => {
    const { root, profile } = await fixture("import './helper.mjs'\n")
    await writeFile(join(root, 'actual.mjs'), 'export const value = 1')
    await symlink(join(root, 'actual.mjs'), join(root, 'helper.mjs'))

    await expect(withDevModuleFiles(profile, root, 'typescript')).rejects.toThrow('symbolic link')
  })

  it('shouldKeepPackagesSeparateWhenTheyUseDifferentMetadata', async () => {
    const { root, profile } = await fixture("import { model } from 'model-package'\nexport { model }\n")
    await mkdir(join(root, 'node_modules/model-package'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/model-package/package.json'),
      JSON.stringify({ name: 'model-package', version: '2.3.4', main: './index.js' })
    )
    await writeFile(join(root, 'node_modules/model-package/index.js'), 'exports.model = {}')

    const result = await withDevModuleFiles(profile, root, 'typescript')

    expect(result.dependencies.typescript['model-package']).toBe('2.3.4')
    expect(result.modelModule?.files).toEqual([join(root, 'model.mjs')])
    expect(await readFile(join(root, 'model.mjs'), 'utf8')).toContain('model-package')
  })
})
