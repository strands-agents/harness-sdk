import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureInitialCandidate, initializeWorkspaceBinding } from '../../src/dev/initialize.js'
import { initializeDevWorkspace, readDevWorkspace } from '../../src/dev/workspace.js'
import * as installer from '../../src/project/archive.js'
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
    expect(config.agent.path).toBe(workspace.root)
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
})
