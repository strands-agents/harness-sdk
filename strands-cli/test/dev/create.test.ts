import { chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { CliConfigStore } from '../../src/config/store.js'
import {
  createDevProject,
  createDevWorkspace,
  bindExistingAgent,
  folderClaims,
  withDevModuleFiles,
} from '../../src/dev/create.js'
import { readDevWorkspace } from '../../src/dev/workspace.js'
import { devFailure } from '../../src/dev/errors.js'
import * as installer from '../../src/project/archive.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const snapshot = () =>
  CliConfigStore.memory(
    {},
    {},
    { profile: { name: 'Test harness', instructions: 'Say hello.', session: false, memory: false, skills: false } }
  ).snapshot()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('createDevWorkspace', () => {
  it.each(['cli', 'typescript', 'python'] as const)(
    'shouldInstallTheExportedPersistentAgentWhenCreating%s',
    async (kind) => {
      const cwd = await temporaryDirectory()
      const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

      const workspace = await createDevWorkspace({ cwd, destination: 'workspace', kind, snapshot: snapshot() })

      expect(workspace.directory).toBe(join(cwd, 'workspace'))
      expect(workspace.root).toBe(join(cwd, 'workspace/agent'))
      expect(workspace.entrypoint).toBe(join(workspace.root, kind === 'python' ? 'agent/agent.py' : 'agent/agent.ts'))
      expect(install).toHaveBeenCalledExactlyOnceWith(workspace.root, kind === 'python' ? 'python' : 'typescript')
      const binding = JSON.parse(await readFile(join(workspace.directory!, '.config'), 'utf8'))
      expect(binding.agent).toEqual({
        path: 'agent',
        entrypoint: kind === 'python' ? 'agent/agent.py' : 'agent/agent.ts',
        language: kind === 'python' ? 'python' : 'typescript',
      })
      expect(await readdir(join(workspace.directory!, 'tmp'))).toEqual([])
      expect(await readDevWorkspace(workspace.directory!)).toEqual(workspace)
      expect(await readFile(workspace.entrypoint, 'utf8')).toContain('Say hello.')
      await expect(readFile(join(workspace.directory!, '.strands/config.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

  it('shouldCopyLocalModelSourcesWithoutMutatingTheSavedProfile', async () => {
    const cwd = await temporaryDirectory()
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    await mkdir(join(cwd, 'models'))
    const modelPath = join(cwd, 'models/custom.mjs')
    await writeFile(modelPath, "import { value } from './helper.mjs'\nexport const model = {value}\n")
    await writeFile(join(cwd, 'models/helper.mjs'), 'export const value = 1\n')
    await writeFile(join(cwd, 'models/.env'), 'PRIVATE=not-exported\n')
    const saved = snapshot()
    saved.profile.modelModule = { kind: 'model', module: modelPath, export: 'model' }
    const original = globalThis.structuredClone(saved)

    const workspace = await createDevWorkspace({ cwd, destination: 'workspace', kind: 'typescript', snapshot: saved })

    expect(saved).toEqual(original)
    expect(await readFile(join(workspace.root, 'agent/extensions/model/helper.mjs'), 'utf8')).toContain('value')
    await expect(readFile(join(workspace.root, 'agent/extensions/model/.env'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('shouldBindAnExistingDefaultWithoutCopyingItsProject', async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, 'existing'))
    await writeFile(join(cwd, 'existing/package.json'), '{"type":"module"}')
    const agent = join(cwd, 'existing/agent.ts')
    await writeFile(agent, 'original source')
    const saved = snapshot()
    saved.agentProject = agent
    const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

    const workspace = await createDevWorkspace({ cwd, destination: 'workspace', kind: 'cli', snapshot: saved })

    expect(workspace.entrypoint).toBe(agent)
    expect(await readFile(agent, 'utf8')).toBe('original source')
    expect(install).not.toHaveBeenCalled()
    expect(await readdir(workspace.directory!)).toEqual(expect.arrayContaining(['.config', 'tmp']))
    await expect(readFile(join(workspace.directory!, 'agent/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shouldPreserveExistingWorkspacesWhenCreationIsRepeated', async () => {
    const cwd = await temporaryDirectory()
    const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const options = { cwd, destination: 'workspace', kind: 'typescript' as const, snapshot: snapshot() }
    const first = await createDevWorkspace(options)
    await writeFile(first.entrypoint, 'edited')

    expect(await createDevWorkspace(options)).toEqual(first)
    expect(await readFile(first.entrypoint, 'utf8')).toBe('edited')
    expect(install).toHaveBeenCalledOnce()
  })

  it('shouldRemoveOnlyTheNewWorkspaceWhenInstallationFails', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'keep.txt'), 'keep')
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockRejectedValue(new Error('install failed'))

    await expect(
      createDevWorkspace({ cwd, destination: 'workspace', kind: 'typescript', snapshot: snapshot() })
    ).rejects.toThrow('install failed')
    expect(await readdir(cwd)).toEqual(['keep.txt'])
  })

  it('shouldCreateTheWorkspaceInsideAnExistingEmptyFolder', async () => {
    const cwd = await temporaryDirectory()
    const folder = join(cwd, 'workspace')
    await mkdir(folder)
    const { ino } = await lstat(folder)
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

    const workspace = await createDevWorkspace({
      cwd,
      destination: 'workspace',
      kind: 'typescript',
      snapshot: snapshot(),
    })

    expect(workspace.directory).toBe(folder)
    expect((await lstat(folder)).ino).toBe(ino)
  })

  it('shouldKeepAnExistingEmptyFolderWhenInstallationFails', async () => {
    const cwd = await temporaryDirectory()
    const folder = join(cwd, 'workspace')
    await mkdir(folder)
    const { ino } = await lstat(folder)
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockRejectedValue(new Error('install failed'))

    await expect(
      createDevWorkspace({ cwd, destination: 'workspace', kind: 'typescript', snapshot: snapshot() })
    ).rejects.toThrow('install failed')
    expect((await lstat(folder)).ino).toBe(ino)
    expect(await readdir(folder)).toEqual([])
  })

  it('shouldRefuseADestinationThatContainsFiles', async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, 'workspace'))
    await writeFile(join(cwd, 'workspace/keep.txt'), 'keep')

    await expect(
      createDevWorkspace({ cwd, destination: 'workspace', kind: 'typescript', snapshot: snapshot() })
    ).rejects.toThrow('The destination already exists')
    expect(await readdir(join(cwd, 'workspace'))).toEqual(['keep.txt'])
  })

  it('shouldLeaveNoWorkspaceWhenInstallationIsCancelled', async () => {
    const cwd = await temporaryDirectory()
    const abort = new AbortController()
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockImplementation(async () => {
      abort.abort(new Error('cancelled'))
    })

    await expect(
      createDevWorkspace({
        cwd,
        destination: 'workspace',
        kind: 'typescript',
        snapshot: snapshot(),
        signal: abort.signal,
      })
    ).rejects.toThrow('cancelled')
    expect(await readdir(cwd)).toEqual([])
  })

  it('shouldBindWithoutEditingAnExistingAgentWhenSelected', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'package.json'), '{"type":"module"}')
    await writeFile(join(cwd, 'agent.ts'), 'source')

    const bound = await bindExistingAgent(join(cwd, 'strands-dev'), join(cwd, 'agent.ts'))

    expect(bound.root).toBe(cwd)
    expect(bound.entrypoint).toBe(join(cwd, 'agent.ts'))
    expect(await readFile(bound.entrypoint, 'utf8')).toBe('source')
  })

  it('shouldOpenTheBoundAgentWhenItsProjectFolderIsMovedWithTheWorkspace', async () => {
    const parent = await temporaryDirectory()
    const project = join(parent, 'project')
    await mkdir(project)
    await writeFile(join(project, 'package.json'), '{"type":"module"}')
    await writeFile(join(project, 'agent.ts'), 'source')
    await bindExistingAgent(join(project, 'strands-dev'), join(project, 'agent.ts'))
    const moved = join(parent, 'moved')

    await rename(project, moved)

    expect(JSON.parse(await readFile(join(moved, 'strands-dev', '.config'), 'utf8')).agent.path).toBe('..')
    expect(await readDevWorkspace(join(moved, 'strands-dev'))).toMatchObject({
      root: moved,
      entrypoint: join(moved, 'agent.ts'),
    })
  })
})

describe('createDevProject', () => {
  it.each(['typescript', 'python'] as const)(
    'shouldCreateTheProjectInStrandsWorkspaceWithItsWorkspaceInsideWhenCreatingA%sHarness',
    async (language) => {
      const cwd = await temporaryDirectory()
      const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

      const workspace = await createDevProject({ cwd, language, snapshot: snapshot() })

      const root = join(cwd, 'strands-workspace')
      const entrypoint = language === 'python' ? 'agent.py' : 'agent.ts'
      expect(workspace.root).toBe(root)
      expect(workspace.directory).toBe(join(root, 'strands-dev'))
      expect(workspace.entrypoint).toBe(join(root, entrypoint))
      expect(workspace.config.origin.kind).toBe('created')
      expect(install).toHaveBeenCalledExactlyOnceWith(root, language)
      expect(JSON.parse(await readFile(join(root, 'strands-dev/.config'), 'utf8')).agent).toEqual({
        path: '..',
        entrypoint,
        language,
      })
      expect(await readDevWorkspace(workspace.directory!)).toEqual(workspace)
      expect(await readdir(cwd)).toEqual(['strands-workspace'])
      expect(await readdir(root)).toContain(entrypoint)
      expect(await readdir(root)).not.toContain('agent')
    }
  )

  it.each([
    ['APythonHarnessFromATypeScriptModelModule', 'python', 'custom.mjs'],
    ['ATypeScriptHarnessFromAPythonModelModule', 'typescript', 'custom.py'],
  ] as const)('shouldUseTheProfileModelWhenCreating%s', async (_case, language, file) => {
    const cwd = await temporaryDirectory()
    const base = await temporaryDirectory()
    await mkdir(join(base, 'models'))
    await writeFile(join(base, 'models', file), language === 'python' ? 'export default {}\n' : 'model = None\n')
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const profile = CliConfigStore.memory(
      {},
      {},
      {
        profile: {
          name: 'Test harness',
          model: 'bedrock/us.example.model',
          modelModule: { kind: 'model', module: `./models/${file}`, files: [`./models/${file}`] },
          session: false,
          memory: false,
          skills: false,
        },
        profileBaseDir: base,
      }
    ).snapshot()

    const workspace = await createDevProject({ cwd, language, snapshot: profile, deferDependencies: true })

    const source = await readFile(workspace.entrypoint, 'utf8')
    expect(source).toContain('bedrock/us.example.model')
    expect(source).not.toContain(file)
    expect(profile.profile.modelModule?.module).toBe(`./models/${file}`)
  })

  const discoverySnapshot = (skills: true | string[]) =>
    CliConfigStore.memory(
      {},
      { skillDiscovery: true },
      { profile: { name: 'Test harness', instructions: 'Say hello.', session: false, memory: false, skills } }
    ).snapshot()

  it('shouldCreateTheProjectWhenTheDiscoveredSkillFoldersDoNotExist', async () => {
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const cwd = await temporaryDirectory()
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

    const workspace = await createDevProject({ cwd, language: 'typescript', snapshot: discoverySnapshot(true) })

    expect(workspace.entrypoint).toBe(join(cwd, 'strands-workspace', 'agent.ts'))
  })

  const writeSkill = async (folder: string, rules: string): Promise<void> => {
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'SKILL.md'),
      `---\nname: ${basename(folder)}\ndescription: Review code.\n---\n${rules}\n`
    )
  }

  it('shouldCopyOnlyTheProfileSkillsWhenSkillDiscoveryIsOn', async () => {
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const cwd = await temporaryDirectory()
    await writeSkill(join(home, '.codex', 'skills', 'review'), 'Use the home rules.')
    await writeSkill(join(cwd, '.agents', 'skills', 'review'), 'Use the project rules.')
    await writeSkill(join(cwd, 'my-skills', 'lint'), 'Use the lint rules.')
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

    const workspace = await createDevProject({
      cwd,
      language: 'typescript',
      snapshot: discoverySnapshot(['./my-skills']),
    })

    expect(await readdir(join(workspace.root, 'agent', 'skills'))).toEqual(['lint'])
  })

  it('shouldSkipConfiguredSkillFoldersThatDoNotExistWhenCreatingTheProject', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'notes.txt'), 'not a folder')
    await writeSkill(join(cwd, 'my-skills', 'lint'), 'Use the lint rules.')
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

    const workspace = await createDevProject({
      cwd,
      language: 'typescript',
      snapshot: discoverySnapshot(['./missing-skills', './notes.txt/skills', './my-skills']),
    })

    expect(await readdir(join(workspace.root, 'agent', 'skills'))).toEqual(['lint'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'shouldRefuseASkillFolderThatExistsButCannotBeRead',
    async () => {
      const cwd = await temporaryDirectory()
      const locked = join(cwd, 'locked')
      await writeSkill(join(locked, 'skills', 'lint'), 'Use the lint rules.')
      vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
      await chmod(locked, 0o000)

      try {
        const creation = createDevProject({
          cwd,
          language: 'typescript',
          snapshot: discoverySnapshot(['./locked/skills']),
        })

        await expect(creation).rejects.toThrow(`Configured skill source "${join(locked, 'skills')}" cannot be read.`)
        expect(devFailure(await creation.catch((error: unknown) => error), { operation: 'open' }).message).toMatch(
          /^Workspace could not open\./u
        )
      } finally {
        await chmod(locked, 0o755)
      }
    }
  )

  it('shouldRefuseToWriteIntoStrandsWorkspaceWhenItAlreadyExists', async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, 'strands-workspace'))
    await writeFile(join(cwd, 'strands-workspace/keep.txt'), 'keep')

    await expect(
      createDevProject({ cwd, language: 'typescript', snapshot: snapshot(), deferDependencies: true })
    ).rejects.toThrow('already exists')

    expect(await readdir(cwd)).toEqual(['strands-workspace'])
    expect(await readdir(join(cwd, 'strands-workspace'))).toEqual(['keep.txt'])
  })

  it('shouldRemoveOnlyTheNewProjectWhenInstallationFails', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'keep.txt'), 'keep')
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockRejectedValue(new Error('install failed'))

    await expect(createDevProject({ cwd, language: 'typescript', snapshot: snapshot() })).rejects.toThrow(
      'install failed'
    )
    expect(await readdir(cwd)).toEqual(['keep.txt'])
    expect(await readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('shouldLeaveNoProjectWhenCreationIsCancelled', async () => {
    const cwd = await temporaryDirectory()
    const abort = new AbortController()
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockImplementation(async () => {
      abort.abort(new Error('cancelled'))
    })

    await expect(
      createDevProject({ cwd, language: 'python', snapshot: snapshot(), signal: abort.signal })
    ).rejects.toThrow('cancelled')
    expect(await readdir(cwd)).toEqual([])
  })
})

describe('folderClaims', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'shouldDeleteTheOtherClaimedFoldersWhenOneDeleteFails',
    async () => {
      const root = await temporaryDirectory()
      const locked = join(root, 'locked')
      await mkdir(locked)
      const claims = folderClaims()
      await claims.claim(join(root, 'strands-dev'))
      await claims.claim(join(locked, 'strands-dev'))
      await mkdir(join(root, 'strands-dev'))
      await mkdir(join(locked, 'strands-dev'))
      await chmod(locked, 0o500)

      try {
        await expect(claims.release()).rejects.toThrow('EACCES')
      } finally {
        await chmod(locked, 0o700)
      }

      expect(await readdir(root)).toEqual(['locked'])
      expect(await readdir(locked)).toEqual(['strands-dev'])
    }
  )
})

describe('folderClaims', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'shouldStillRestoreAReplacedFolderWhenAnotherClaimCannotBeDeleted',
    async () => {
      const root = await temporaryDirectory()
      const locked = join(root, 'locked')
      await mkdir(join(locked, 'made'), { recursive: true })
      const replaced = join(root, 'strands-dev')
      await mkdir(replaced)
      await writeFile(join(replaced, '.config'), 'old')
      const claims = folderClaims()
      claims.claimCreated(join(locked, 'made'))
      await claims.replace(replaced)
      await mkdir(replaced)
      await chmod(locked, 0o500)

      try {
        await expect(claims.release()).rejects.toThrow(`Could not delete ${join(locked, 'made')}`)
      } finally {
        await chmod(locked, 0o700)
      }

      expect(await readFile(join(replaced, '.config'), 'utf8')).toBe('old')
      expect((await readdir(root)).sort()).toEqual(['locked', 'strands-dev'])
    }
  )
})

describe('folderClaims replacement', () => {
  it('shouldRefuseToReplaceAFolderThatHoldsTheAgentOfPlainStrands', async () => {
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const folder = join(home, '.strands', 'strands-dev')
    await mkdir(join(folder, 'agent'), { recursive: true })
    await writeFile(
      join(home, '.strands', 'cli.toml'),
      `agentProject = ${JSON.stringify(join(folder, 'agent', 'agent.ts'))}\n`
    )
    const claims = folderClaims()

    await expect(claims.replace(folder)).rejects.toThrow(
      `Plain strands uses the agent ${join(folder, 'agent', 'agent.ts')}`
    )

    expect(await readdir(folder)).toEqual(['agent'])
  })
})

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
