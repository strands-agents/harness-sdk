import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindExistingAgent } from '../../src/dev/create.js'
import { createCandidate, assertCandidateCurrent } from '../../src/dev/candidates.js'
import * as installer from '../../src/project/archive.js'
import { readDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const fixture = async () => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'package.json'), '{"name":"source-agent","version":"1.0.0","type":"module"}')
  await writeFile(join(root, 'agent.ts'), "export const agent = {name:'current agent'}\n")
  await mkdir(join(root, '.agent/sessions'), { recursive: true })
  await writeFile(join(root, '.agent/sessions/private.json'), 'private')
  return bindExistingAgent(join(root, 'strands-dev'), join(root, 'agent.ts'))
}

afterEach(() => vi.restoreAllMocks())

describe('candidate projects', () => {
  it('shouldCopyCurrentSourceAndInstallIndependentlyWhenCreatingCandidates', async () => {
    const workspace = await fixture()
    const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const original = await readFile(workspace.entrypoint, 'utf8')
    const binding = await readFile(join(workspace.directory!, '.config'), 'utf8')

    const [first, second] = await Promise.all([createCandidate(workspace), createCandidate(workspace)])

    expect(first.directory).not.toBe(second.directory)
    expect(first.directory.startsWith(join(workspace.directory!, 'tmp'))).toBe(true)
    expect(await readFile(first.entrypoint, 'utf8')).toBe(original)
    expect(await readFile(join(first.directory, 'baseline/agent.ts'), 'utf8')).toBe(original)
    expect(install).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenCalledWith(join(first.directory, 'agent'), 'typescript')
    await expect(readFile(join(first.directory, 'agent/.agent/sessions/private.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(join(first.directory, 'agent/strands-dev/.config'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(first.entrypoint, 'candidate changed')
    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(original)
    expect(await readFile(second.entrypoint, 'utf8')).toBe(original)
    expect(await readFile(join(workspace.directory!, '.config'), 'utf8')).toBe(binding)
    expect((await readDevWorkspace(workspace.directory!))?.entrypoint).toBe(workspace.entrypoint)
  })

  it('shouldRejectStaleCandidatesWhenTheMainAgentChanges', async () => {
    const workspace = await fixture()
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
    const candidate = await createCandidate(workspace)

    await expect(assertCandidateCurrent(workspace, candidate)).resolves.toBeUndefined()
    await writeFile(workspace.entrypoint, 'main changed')

    await expect(assertCandidateCurrent(workspace, candidate)).rejects.toThrow('main agent changed')
  })

  it('shouldRemoveOnlyFailedCandidateWhenDependencyInstallationFails', async () => {
    const workspace = await fixture()
    vi.spyOn(installer, 'prepareWorkspaceDependencies').mockRejectedValue(new Error('install failed'))

    await expect(createCandidate(workspace)).rejects.toThrow('install failed')

    expect(await readdir(join(workspace.directory!, 'tmp'))).toEqual([])
    expect(await readFile(workspace.entrypoint, 'utf8')).toContain('current agent')
  })
})
