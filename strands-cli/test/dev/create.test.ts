import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { createDevWorkspace, bindExistingAgent } from '../../src/dev/create.js'
import { readDevWorkspace } from '../../src/dev/workspace.js'
import * as installer from '../../src/project/archive.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const snapshot = () =>
  CliConfigStore.memory(
    {},
    {},
    { profile: { name: 'Test harness', instructions: 'Say hello.', session: false, memory: false, skills: false } }
  ).snapshot()

afterEach(() => vi.restoreAllMocks())

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
})
