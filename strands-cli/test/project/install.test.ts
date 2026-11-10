import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { installAgentProject } from '../../src/project/install.js'
import * as archive from '../../src/project/archive.js'
import * as exporter from '../../src/project/export.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

afterEach(() => vi.restoreAllMocks())

describe('shared agent project installation', () => {
  it('shouldReportTheProjectPathAndNextStepWhenDependencyInstallationFails', async () => {
    const root = await temporaryDirectory()
    const destination = join(root, 'agent')
    const underlying = new Error('npm error 404 Missing test dependency')
    vi.spyOn(archive, 'prepareWorkspaceDependencies').mockRejectedValue(underlying)

    const task = installAgentProject({
      destination,
      profile: defineHarnessAgentConfig({ skills: false }),
      language: 'typescript',
      skills: [],
      baseDir: root,
    })

    await expect(task).rejects.toThrow('Agent dependency setup failed.')
    await expect(task).rejects.toThrow(`Path: ${destination}`)
    await expect(task).rejects.toThrow('Next: Check the dependency files')
    await expect(task).rejects.toMatchObject({ cause: underlying })
  })

  it('shouldUseTheProfileExporterBeforeInstallingDependenciesWhenCreatingAnAgent', async () => {
    const root = await temporaryDirectory()
    const destination = join(root, 'agent')
    const exportProject = vi.spyOn(exporter, 'writeAgentProject')
    const install = vi.spyOn(archive, 'prepareWorkspaceDependencies').mockResolvedValue()
    const profile = defineHarnessAgentConfig({ skills: false })

    const project = await installAgentProject({
      destination,
      profile,
      language: 'typescript',
      skills: [],
      baseDir: root,
    })

    expect(exportProject).toHaveBeenCalledWith(profile, 'typescript', [], destination, root, false, 'directory')
    expect(install).toHaveBeenCalledExactlyOnceWith(project.root, 'typescript')
    expect(exportProject.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]!)
  })

  it('shouldUseTheSourceExporterWhenInstallingACandidate', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'package.json'), '{"type":"module"}')
    await writeFile(join(source, 'agent.ts'), 'export const agent = {}')
    const sourceProject = { root: source, entrypoint: join(source, 'agent.ts'), language: 'typescript' as const }
    const exportProject = vi.spyOn(exporter, 'exportSourceProject')
    const install = vi.spyOn(archive, 'prepareWorkspaceDependencies').mockResolvedValue()

    const project = await installAgentProject({
      destination: join(root, 'candidate'),
      source: sourceProject,
      name: 'candidate',
      privatePaths: [],
    })

    expect(exportProject).toHaveBeenCalledWith(sourceProject, 'candidate', 'typescript', [], project.root, 'directory')
    expect(install).toHaveBeenCalledExactlyOnceWith(project.root, 'typescript')
  })
})
