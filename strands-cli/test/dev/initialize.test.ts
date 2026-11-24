import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindExistingAgent } from '../../src/dev/create.js'
import { ensureInitialCandidate, ensureInitialCopy, initializeWorkspaceBinding } from '../../src/dev/initialize.js'
import { initializeDevWorkspace, readDevWorkspace } from '../../src/dev/workspace.js'
import * as installer from '../../src/project/archive.js'
import * as preparation from '../../src/project/preparation.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

afterEach(() => vi.restoreAllMocks())

const legacy = async () => {
  const launch = await temporaryDirectory()
  const root = join(launch, 'strands-dev/base-cli')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"legacy","version":"1.0.0","type":"module"}')
  await writeFile(join(root, 'src/agent.ts'), 'export const agent = {name:"original"}')
  await writeFile(join(root, '.strands-entrypoint'), './src/agent.ts\n')
  const workspace = await initializeDevWorkspace(root, {
    version: 1,
    name: 'Base CLI',
    language: 'typescript',
    entrypoint: 'src/agent.ts',
    origin: { kind: 'cli' },
  })
  return { launch, workspace }
}

describe('workspace initialization', () => {
  it('shouldBindTheLegacyAgentAndInstallItsInitialCopyWithoutMovingSource', async () => {
    const { launch, workspace } = await legacy()
    const source = await readFile(workspace.entrypoint, 'utf8')
    const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()

    const bound = await initializeWorkspaceBinding(workspace, join(launch, 'strands-dev'))
    const initial = await ensureInitialCandidate(bound)

    expect(bound.root).toBe(workspace.root)
    expect(bound.entrypoint).toBe(workspace.entrypoint)
    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source)
    const config = JSON.parse(await readFile(join(launch, 'strands-dev/.config'), 'utf8'))
    expect(config.agent.path).toBe('base-cli')
    expect(await readFile(join(initial, 'agent/src/agent.ts'), 'utf8')).toBe(source)
    expect(install).toHaveBeenCalledExactlyOnceWith(join(initial, 'agent'), 'typescript')
    expect((await readDevWorkspace(join(launch, 'strands-dev')))?.entrypoint).toBe(workspace.entrypoint)
  })

  it('shouldReuseTheInitialCopyWhenTheWorkspaceIsOpenedAgain', async () => {
    const { launch, workspace } = await legacy()
    const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const bound = await initializeWorkspaceBinding(workspace, join(launch, 'strands-dev'))
    const initial = await ensureInitialCandidate(bound)
    await writeFile(join(initial, 'agent/src/agent.ts'), 'candidate edits')

    expect(await ensureInitialCandidate(bound)).toBe(initial)
    expect(install).toHaveBeenCalledOnce()
    expect(await readFile(join(initial, 'agent/src/agent.ts'), 'utf8')).toBe('candidate edits')
    expect(await readdir(join(bound.directory!, 'tmp'))).toHaveLength(2)
  })

  it('shouldCopyAndReuseTheBoundAgentWhenTheLaunchRunsAnotherEntrypoint', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'agent.ts'), 'export const agent = {name:"bound"}')
    await writeFile(join(root, 'other.ts'), 'export const agent = {name:"other"}')
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const bound = await bindExistingAgent(join(root, 'strands-dev'), join(root, 'agent.ts'))
    const other = { ...bound, entrypoint: join(root, 'other.ts'), config: { ...bound.config, entrypoint: 'other.ts' } }

    const initial = await ensureInitialCandidate(other)

    expect(JSON.parse(await readFile(join(initial, 'candidate.json'), 'utf8')).source.entrypoint).toBe(bound.entrypoint)
    expect(await ensureInitialCandidate(other)).toBe(initial)
    expect(await ensureInitialCandidate(bound)).toBe(initial)
    expect(await readdir(join(bound.directory!, 'tmp'))).toHaveLength(2)
  })

  it('shouldAllowRetryWhenInitialInstallationFails', async () => {
    const { launch, workspace } = await legacy()
    const bound = await initializeWorkspaceBinding(workspace, join(launch, 'strands-dev'))
    vi.spyOn(installer, 'prepareWorkspaceDependencies')
      .mockRejectedValueOnce(new Error('install failed'))
      .mockResolvedValue()

    await expect(ensureInitialCandidate(bound)).rejects.toThrow('install failed')
    expect(await readdir(join(bound.directory!, 'tmp'))).toEqual([])
    await expect(ensureInitialCandidate(bound)).resolves.toContain(join(bound.directory!, 'tmp'))
  })

  it('shouldInstallTheInitialCopyWithTheDeclaredPreparationWhenOptimizeStarts', async () => {
    const { launch, workspace } = await legacy()
    const source = await readFile(workspace.entrypoint, 'utf8')
    const execute = vi.spyOn(preparation, 'executePreparation').mockResolvedValue(join(launch, 'setup.log'))
    const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const bound = await initializeWorkspaceBinding(workspace, join(launch, 'strands-dev'))

    const initial = await ensureInitialCopy(bound)

    expect(await readFile(join(initial, 'agent/src/agent.ts'), 'utf8')).toBe(source)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0].project.root).toBe(join(initial, 'agent'))
    expect(install).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(bound.directory!, 'tmp/initial.json'), 'utf8')).id).toBe(
      JSON.parse(await readFile(join(initial, 'candidate.json'), 'utf8')).id
    )
  })

  it('shouldReuseTheInitialCopyWhenOptimizeStartsAgain', async () => {
    const { launch, workspace } = await legacy()
    const execute = vi.spyOn(preparation, 'executePreparation').mockResolvedValue(join(launch, 'setup.log'))
    const bound = await initializeWorkspaceBinding(workspace, join(launch, 'strands-dev'))
    const initial = await ensureInitialCopy(bound)

    const again = await ensureInitialCopy(bound)

    expect(again).toBe(initial)
    expect(execute).toHaveBeenCalledOnce()
    expect(await readdir(join(bound.directory!, 'tmp'))).toHaveLength(2)
  })
})
