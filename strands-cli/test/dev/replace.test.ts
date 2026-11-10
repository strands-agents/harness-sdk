import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import { createWorkspaceReplacement } from '../../src/dev/replace.js'
import { readDevWorkspace } from '../../src/dev/workspace.js'
import * as initial from '../../src/dev/initialize.js'
import * as archive from '../../src/project/archive.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const fixture = async () => {
  const root = await temporaryDirectory()
  const original = join(root, 'original')
  const incoming = join(root, 'incoming')
  for (const path of [original, incoming]) {
    await mkdir(path)
    await writeFile(join(path, 'package.json'), '{"type":"module"}')
    await writeFile(join(path, 'agent.ts'), `export const agent = ${JSON.stringify(path)}`)
  }
  const workspace = await bindExistingAgent(join(root, 'strands-dev'), join(original, 'agent.ts'))
  await writeFile(join(workspace.directory!, 'keep.txt'), 'old workspace')
  return {
    root,
    original,
    incoming,
    workspace,
    snapshot: CliConfigStore.memory({}, {}, { profile: { skills: false, memory: false, session: false } }).snapshot(),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('workspace replacement', () => {
  it('shouldReplaceOnlyTheConfirmedWorkspaceWhenImportingAnotherAgent', async () => {
    const { root, original, incoming, workspace, snapshot } = await fixture()
    vi.spyOn(initial, 'ensureInitialCandidate').mockResolvedValue('copy')
    const transaction = await createWorkspaceReplacement({
      workspace,
      snapshot,
      request: { kind: 'import', path: join(incoming, 'agent.ts') },
    })
    const before = await readFile(join(workspace.directory!, '.config'), 'utf8')

    expect(await readFile(join(workspace.directory!, 'keep.txt'), 'utf8')).toBe('old workspace')
    const replacement = await transaction.apply()

    expect(replacement.entrypoint).toBe(join(incoming, 'agent.ts'))
    expect(await readFile(join(original, 'agent.ts'), 'utf8')).toContain(original)
    expect(await readFile(join(incoming, 'agent.ts'), 'utf8')).toContain(incoming)
    expect(await readFile(join(workspace.directory!, '.config'), 'utf8')).not.toBe(before)
    await expect(readFile(join(workspace.directory!, 'keep.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).some((name) => name.endsWith('.workspace-backup'))).toBe(true)
    await transaction.finish()
    expect((await readdir(root)).sort()).toEqual(['incoming', 'original', 'strands-dev'])
  })

  it('shouldRestoreOriginalFilesWhenTheNewAgentCannotStart', async () => {
    const { root, incoming, workspace, snapshot } = await fixture()
    vi.spyOn(initial, 'ensureInitialCandidate').mockResolvedValue('copy')
    const before = await readFile(join(workspace.directory!, '.config'), 'utf8')
    const transaction = await createWorkspaceReplacement({
      workspace,
      snapshot,
      request: { kind: 'import', path: incoming },
    })

    await transaction.apply()
    await transaction.rollback()
    await transaction.rollback()

    expect(await readFile(join(workspace.directory!, '.config'), 'utf8')).toBe(before)
    expect(await readFile(join(workspace.directory!, 'keep.txt'), 'utf8')).toBe('old workspace')
    expect((await readdir(root)).some((name) => name.endsWith('.workspace-backup'))).toBe(false)
  })

  it('shouldRestoreTheWorkspaceWhenTheInitialCopyFails', async () => {
    const { incoming, workspace, snapshot } = await fixture()
    vi.spyOn(initial, 'ensureInitialCandidate').mockRejectedValue(new Error('dependency setup failed'))
    const transaction = await createWorkspaceReplacement({
      workspace,
      snapshot,
      request: { kind: 'import', path: incoming },
    })

    await expect(transaction.apply()).rejects.toThrow('dependency setup failed')

    expect(await readFile(join(workspace.directory!, 'keep.txt'), 'utf8')).toBe('old workspace')
    expect((await readDevWorkspace(workspace.directory!))?.entrypoint).toBe(workspace.entrypoint)
  })

  it('shouldRejectStaleConfirmationWhenTheBindingChanges', async () => {
    const { incoming, workspace, snapshot } = await fixture()
    const transaction = await createWorkspaceReplacement({
      workspace,
      snapshot,
      request: { kind: 'import', path: incoming },
    })
    const configPath = join(workspace.directory!, '.config')
    const changed = `${await readFile(configPath, 'utf8')}\n`
    await writeFile(configPath, changed)

    await expect(transaction.apply()).rejects.toThrow('changed after confirmation')

    expect(await readFile(configPath, 'utf8')).toBe(changed)
    expect(await readFile(join(workspace.directory!, 'keep.txt'), 'utf8')).toBe('old workspace')
  })

  it('shouldRejectImportingSourceThatDeletionWouldRemove', async () => {
    const { workspace, snapshot } = await fixture()
    const nested = join(workspace.directory!, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'package.json'), '{"type":"module"}')
    await writeFile(join(nested, 'agent.ts'), 'source')

    await expect(
      createWorkspaceReplacement({ workspace, snapshot, request: { kind: 'import', path: nested } })
    ).rejects.toThrow('outside the workspace')
    expect(await readFile(join(nested, 'agent.ts'), 'utf8')).toBe('source')
  })

  it('shouldInstallANewPersistentAgentWhenCreationIsConfirmed', async () => {
    const { workspace, snapshot } = await fixture()
    vi.spyOn(initial, 'ensureInitialCandidate').mockResolvedValue('copy')
    vi.spyOn(archive, 'prepareWorkspaceDependencies').mockResolvedValue()
    const transaction = await createWorkspaceReplacement({
      workspace,
      snapshot,
      request: { kind: 'create', language: 'typescript', name: 'Replacement' },
    })

    const replacement = await transaction.apply()

    expect(replacement.config.name).toBe('Replacement')
    expect(replacement.entrypoint).toBe(join(workspace.directory!, 'agent/agent/agent.ts'))
    await transaction.finish()
  })

  it('shouldLeaveTheWorkspaceUntouchedWhenCancellationComesBeforeApply', async () => {
    const { incoming, workspace, snapshot } = await fixture()
    const abort = new AbortController()
    const transaction = await createWorkspaceReplacement({
      workspace,
      snapshot,
      request: { kind: 'import', path: incoming },
      signal: abort.signal,
    })
    abort.abort(new Error('cancelled'))

    await expect(transaction.apply()).rejects.toThrow('cancelled')
    expect(await readFile(join(workspace.directory!, 'keep.txt'), 'utf8')).toBe('old workspace')
  })
})
