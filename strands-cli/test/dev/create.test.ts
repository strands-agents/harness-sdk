import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { createDevWorkspace } from '../../src/dev/create.js'
import * as harnessSource from '../../src/dev/harness-source.js'
import { readDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const snapshot = () =>
  CliConfigStore.memory(
    {},
    {},
    { profile: { name: 'Test harness', instructions: 'Say hello.', session: true, memory: true, skills: false } }
  ).snapshot()

const fakeLibrary = (): void => {
  vi.spyOn(harnessSource, 'copyHarnessSource').mockImplementation(async (path) => {
    await mkdir(join(path, 'src'), { recursive: true })
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({ name: '@strands-agents/harness', version: '0.3.4', exports: { '.': './dist/src/index.js' } })
    )
    await writeFile(join(path, 'src/index.ts'), 'export const marker = 42\n')
    return { path, version: '0.3.4', digest: 'fixture' }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('createDevWorkspace', () => {
  it('shouldCopyTheBaseHarnessWhenCliIsSelected', async () => {
    const cwd = await temporaryDirectory()
    fakeLibrary()

    const workspace = await createDevWorkspace({ cwd, destination: 'workspace', kind: 'cli', snapshot: snapshot() })

    expect(workspace.config).toMatchObject({
      version: 1,
      name: 'Test harness',
      language: 'typescript',
      entrypoint: 'src/agent.ts',
      origin: { kind: 'cli', version: '0.3.4' },
      harness: { path: 'harness', version: '0.3.4' },
    })
    const source = await readFile(workspace.entrypoint, 'utf8')
    expect(source).toContain('Say hello.')
    expect(source).toContain('.strands/state/sessions')
    expect(source).toContain('.strands/state/memory')
    const manifest = JSON.parse(await readFile(join(workspace.root, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@strands-agents/harness']).toBe('file:./harness')
    expect(JSON.parse(await readFile(join(workspace.root, 'harness/package.json'), 'utf8')).exports).toEqual({
      '.': './src/index.ts',
      './internal': './src/internal.ts',
    })
    expect(await readDevWorkspace(workspace.root)).toEqual(workspace)
    await expect(readFile(join(workspace.root, 'node_modules/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['typescript', 'python'] as const)('shouldCreateAnEntrypointWhenLanguageIs%s', async (kind) => {
    const cwd = await temporaryDirectory()
    const original = snapshot()
    original.profile.session = false
    original.profile.memory = false

    const workspace = await createDevWorkspace({ cwd, destination: kind, kind, snapshot: original })

    expect(workspace.config.language).toBe(kind)
    expect(workspace.config.harness).toBeUndefined()
    const source = await readFile(workspace.entrypoint, 'utf8')
    expect(source).toContain(kind === 'python' ? 'session=False' : 'session: false')
    expect(source).toContain(kind === 'python' ? 'memory=False' : 'memory: false')
    expect(await readdir(join(workspace.root, '.strands'))).toEqual(
      expect.arrayContaining(['cases', 'config.json', 'state'])
    )
  })

  it('shouldPreserveAnExistingWorkspaceWhenCreationRunsAgain', async () => {
    const cwd = await temporaryDirectory()
    fakeLibrary()
    const options = { cwd, destination: 'workspace', kind: 'cli' as const, snapshot: snapshot() }
    const first = await createDevWorkspace(options)
    await writeFile(first.entrypoint, 'edited')

    const next = await createDevWorkspace(options)

    expect(next).toEqual(first)
    expect(await readFile(next.entrypoint, 'utf8')).toBe('edited')
    expect(harnessSource.copyHarnessSource).toHaveBeenCalledTimes(1)
  })

  it('shouldRemoveOnlyStagedFilesWhenSourceCopyFails', async () => {
    const cwd = await temporaryDirectory()
    vi.spyOn(harnessSource, 'copyHarnessSource').mockRejectedValue(new Error('matching source unavailable'))
    await writeFile(join(cwd, 'keep.txt'), 'keep')

    await expect(
      createDevWorkspace({ cwd, destination: 'workspace', kind: 'cli', snapshot: snapshot() })
    ).rejects.toThrow('matching source unavailable')

    expect(await readdir(cwd)).toEqual(['keep.txt'])
  })

  it('shouldRejectAnOccupiedDestinationWhenItHasNoWorkspace', async () => {
    const cwd = await temporaryDirectory()
    await mkdir(join(cwd, 'workspace'))
    await writeFile(join(cwd, 'workspace/keep.txt'), 'keep')

    await expect(
      createDevWorkspace({ cwd, destination: 'workspace', kind: 'typescript', snapshot: snapshot() })
    ).rejects.toThrow('already exists')

    expect(await readFile(join(cwd, 'workspace/keep.txt'), 'utf8')).toBe('keep')
  })

  it('shouldKeepPackagedModulePathsWhenTheEntrypointMovesToSrc', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'tools.ts'), 'export const greet = {}\n')
    const saved = snapshot()
    saved.profile.tools = [{ kind: 'tool', module: './tools.ts', export: 'greet', files: ['./tools.ts'] }]

    const workspace = await createDevWorkspace({ cwd, destination: 'workspace', kind: 'typescript', snapshot: saved })

    const source = await readFile(workspace.entrypoint, 'utf8')
    expect(source).toContain('./agent/tools/tools.js')
    expect(await readFile(join(workspace.root, 'agent/tools/tools.ts'), 'utf8')).toContain('greet')
  })
})
