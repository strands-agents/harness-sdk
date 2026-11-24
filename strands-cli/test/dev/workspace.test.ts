import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  findDevWorkspace,
  readDevWorkspace,
  workspaceFolder,
  type DevWorkspaceConfig,
} from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: vi.fn(fs.lstat) }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

function config(overrides: Partial<DevWorkspaceConfig> = {}): DevWorkspaceConfig {
  return {
    version: 1,
    name: 'My harness',
    language: 'typescript',
    entrypoint: 'agent.ts',
    origin: { kind: 'discovered' },
    ...overrides,
  }
}

async function project(entrypoint = 'agent.ts') {
  const root = await realpath(await temporaryDirectory())
  await writeFile(join(root, entrypoint), 'unexecuted source')
  return root
}

async function manifest(root: string, document: unknown) {
  await mkdir(join(root, '.strands'), { recursive: true })
  await writeFile(join(root, '.strands', 'config.json'), JSON.stringify(document))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(lstat).mockReset()
})

describe('readDevWorkspace', () => {
  it('should return undefined When only the manifest is missing', async () => {
    const root = await project()

    expect(await readDevWorkspace(root)).toBeUndefined()
    expect(await readDevWorkspace(join(root, 'missing'))).toBeUndefined()
  })

  it.each([
    ['typescript', 'agent.ts'],
    ['typescript', 'agent.mts'],
    ['typescript', 'agent.js'],
    ['typescript', 'agent.mjs'],
    ['python', 'agent.py'],
  ] as const)('should read the stored metadata When the %s entrypoint is %s', async (language, entrypoint) => {
    const root = await project(entrypoint)
    await mkdir(join(root, 'vendor', 'harness'), { recursive: true })
    const input = config({ language, entrypoint, harness: { path: 'vendor/harness', version: '0.3.4' } })
    await manifest(root, input)

    expect(await readDevWorkspace(root)).toEqual({ root, entrypoint: join(root, entrypoint), config: input })
    expect(await readFile(join(root, entrypoint), 'utf8')).toBe('unexecuted source')
  })

  it.each(['cli', 'created', 'discovered'] as const)(
    'should retain origin fields When the kind is %s',
    async (kind) => {
      const root = await project()
      const origin = { kind, source: '@strands-agents/harness', version: '0.3.4' }
      await manifest(root, config({ origin }))

      expect((await readDevWorkspace(root))?.config.origin).toEqual(origin)
    }
  )

  it('should keep malformed metadata untouched When the manifest is not JSON', async () => {
    const root = await project()
    await mkdir(join(root, '.strands'))
    await writeFile(join(root, '.strands', 'config.json'), '{unfinished')

    await expect(readDevWorkspace(root)).rejects.toThrow()

    expect(await readFile(join(root, '.strands', 'config.json'), 'utf8')).toBe('{unfinished')
    expect(await readdir(root)).toEqual(['.strands', 'agent.ts'])
  })

  it.each([
    ['version', { version: 2 }],
    ['language', { language: 'ruby' }],
    ['language extension', { language: 'python' }],
    ['name', { name: '' }],
    ['blank name', { name: '   ' }],
    ['control characters', { name: 'a\nb' }],
    ['non-string name', { name: 1 }],
    ['origin', { origin: null }],
    ['origin kind', { origin: { kind: 'other' } }],
    ['origin kind array', { origin: { kind: ['cli'] } }],
    ['origin source', { origin: { kind: 'cli', source: false } }],
    ['origin version', { origin: { kind: 'cli', version: '' } }],
    ['harness', { harness: [] }],
    ['harness version', { harness: { path: 'vendor', version: 1 } }],
    ['harness path', { harness: { path: '../vendor', version: '1' } }],
  ])('should reject malformed metadata When %s is invalid', async (_field, overrides) => {
    const root = await project()
    await manifest(root, { ...config(), ...overrides })

    await expect(readDevWorkspace(root)).rejects.toThrow()
  })

  it.each([
    '../agent.ts',
    '/agent.ts',
    'C:\\agent.ts',
    './agent.ts',
    'nested/../agent.ts',
    'a//agent.ts',
    '.git/agent.ts',
    'NUL.ts',
    'missing.ts',
  ])('should reject unsafe or absent entrypoints When the path is %j', async (entrypoint) => {
    const root = await project()
    await manifest(root, config({ entrypoint }))

    await expect(readDevWorkspace(root)).rejects.toThrow()
  })

  it.each(['entrypoint', 'parent', 'harness'] as const)(
    'should reject symlinked paths When the link is the %s',
    async (kind) => {
      const root = await project()
      const outside = await project()
      if (kind === 'entrypoint') {
        await symlink(join(outside, 'agent.ts'), join(root, 'linked.ts'), 'file')
        await manifest(root, config({ entrypoint: 'linked.ts' }))
      } else {
        await symlink(outside, join(root, 'linked'), 'dir')
        await manifest(
          root,
          kind === 'parent'
            ? config({ entrypoint: 'linked/agent.ts' })
            : config({ harness: { path: 'linked', version: '1' } })
        )
      }

      await expect(readDevWorkspace(root)).rejects.toThrow('symbolic link')

      expect(await readdir(outside)).toEqual(['agent.ts'])
    }
  )

  it('should reject internal symlinks When their target is still inside the root', async () => {
    const root = await project()
    await symlink(join(root, 'agent.ts'), join(root, 'linked.ts'), 'file')
    await manifest(root, config({ entrypoint: 'linked.ts' }))

    await expect(readDevWorkspace(root)).rejects.toThrow('symbolic link')
  })

  it.each(['.strands', '.strands/cases', '.strands/state', '.strands/reports', '.strands/config.json'])(
    'should reject dangerous metadata links When %s is a symlink',
    async (path) => {
      const root = await project()
      const outside = await project()
      const file = path.endsWith('json')
      if (path.startsWith('.strands/')) await mkdir(join(root, '.strands'))
      await symlink(file ? join(outside, 'agent.ts') : outside, join(root, path), file ? 'file' : 'dir')

      await expect(readDevWorkspace(root)).rejects.toThrow('symbolic link')

      expect(await readFile(join(outside, 'agent.ts'), 'utf8')).toBe('unexecuted source')
      expect(await readdir(outside)).toEqual(['agent.ts'])
    }
  )

  it.each([null, [], {}, { version: 2 }, { agent: 'agent.ts' }, { model: 'example', tools: [] }])(
    'shouldIgnoreUnrelatedProjectConfigWhenTheDocumentIs%j',
    async (document) => {
      const root = await project()
      await manifest(root, document)
      const path = join(root, '.strands/config.json')
      const before = await readFile(path)

      expect(await readDevWorkspace(root)).toBeUndefined()
      expect(await readFile(path)).toEqual(before)
    }
  )

  it('should reject nonportable stored paths When a manifest contains native separators', async () => {
    const root = await project()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'agent.ts'), 'source')
    await manifest(root, config({ entrypoint: 'src\\agent.ts' }))

    await expect(readDevWorkspace(root)).rejects.toThrow('not portable')
  })

  it('should reject oversized metadata When the manifest exceeds its size bound', async () => {
    const root = await project()
    await manifest(root, { ...config(), name: 'x'.repeat(65536) })

    await expect(readDevWorkspace(root)).rejects.toThrow('exceeds')
  })

  it.each(['root', 'manifest', 'metadata'] as const)(
    'should throw instead of reporting absence When the %s has the wrong file type',
    async (kind) => {
      const root = await project()
      if (kind === 'metadata') await writeFile(join(root, '.strands'), 'not a directory')
      if (kind === 'manifest') await mkdir(join(root, '.strands', 'config.json'), { recursive: true })

      await expect(readDevWorkspace(kind === 'root' ? join(root, 'agent.ts') : root)).rejects.toThrow()
    }
  )

  it('should reject symbolic root directories When opening a workspace', async () => {
    const parent = await temporaryDirectory()
    const root = await project()
    const path = join(parent, 'linked')
    await symlink(root, path, 'dir')

    await expect(readDevWorkspace(path)).rejects.toThrow('symbolic link')
  })

  it('should report missing entrypoints When an existing workspace loses its source', async () => {
    const root = await project()
    await manifest(root, config({ entrypoint: 'missing.ts' }))

    await expect(readDevWorkspace(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('workspaceFolder', () => {
  it.each<[string, (path: string) => Promise<unknown>, (path: string) => string]>([
    ['is missing', async () => undefined, (path) => join(path, 'strands-dev')],
    ['is an empty folder', (path) => mkdir(path), (path) => join(path, 'strands-dev')],
    [
      'holds other files',
      async (path) => {
        await mkdir(path)
        await writeFile(join(path, 'notes.txt'), 'notes')
      },
      (path) => join(path, 'strands-dev'),
    ],
    [
      'holds an unrelated .config folder',
      (path) => mkdir(join(path, '.config'), { recursive: true }),
      (path) => join(path, 'strands-dev'),
    ],
    [
      'holds a workspace binding',
      async (path) => {
        await mkdir(path)
        await writeFile(join(path, '.config'), '{}')
      },
      (path) => path,
    ],
    ['is a file', (path) => writeFile(path, 'notes'), (path) => path],
  ])('shouldResolveTheWorkspaceFolderWhenThePath%s', async (_case, arrange, expected) => {
    const path = join(await temporaryDirectory(), 'chosen')
    await arrange(path)

    expect(await workspaceFolder(path)).toBe(expected(path))
  })

  it.each(['strands-dev-empty', 'my-strands-dev', 'strands-dev-x'])(
    'shouldCreateStrandsDevInsideAnEmptyFolderNamed%s',
    async (name) => {
      const path = join(await temporaryDirectory(), name)
      await mkdir(path)

      expect(await workspaceFolder(path)).toBe(join(path, 'strands-dev'))
    }
  )

  it('shouldReturnThePathAsItIsWhenAFileSitsAboveIt', async () => {
    const file = join(await temporaryDirectory(), 'notes.txt')
    await writeFile(file, 'notes')

    expect(await workspaceFolder(join(file, 'child'))).toBe(join(file, 'child'))
  })

  it('shouldReturnThePathAsItIsWhenAFileSitsAboveItAndTheSystemReportsTheChildAsMissing', async () => {
    const file = join(await temporaryDirectory(), 'notes.txt')
    await writeFile(file, 'notes')
    vi.mocked(lstat).mockImplementation(async (path) => {
      if (String(path).startsWith(`${file}${sep}`)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return actualFs.lstat(path)
    })

    expect(await workspaceFolder(join(file, 'child'))).toBe(join(file, 'child'))
  })

  it('shouldFindNoWorkspaceWhenTheFolderHoldsAnUnrelatedConfigFolder', async () => {
    const path = await temporaryDirectory()
    await mkdir(join(path, '.config'))

    expect(await findDevWorkspace(path)).toBeUndefined()
  })

  it.each([
    ['File', (target: string) => writeFile(target, '{}')],
    ['Folder', (target: string) => mkdir(target)],
  ])('shouldFindNoWorkspaceWhenTheConfigIsALinkToA%s', async (_kind, arrange) => {
    const path = await temporaryDirectory()
    const target = join(await temporaryDirectory(), 'shared-config')
    await arrange(target)
    await symlink(target, join(path, '.config'))

    expect(await findDevWorkspace(path)).toBeUndefined()
  })

  it.each(['strands-dev', 'strands-dev-3'])('shouldUseThePathAsItIsWhenItEndsIn%s', async (name) => {
    const path = join(await temporaryDirectory(), name)

    expect(await workspaceFolder(path)).toBe(path)
  })

  it('shouldUseThePathAsItIsWhenItHoldsALegacyWorkspace', async () => {
    const root = await project()
    await manifest(root, config())

    expect(await workspaceFolder(root)).toBe(root)
  })
})
