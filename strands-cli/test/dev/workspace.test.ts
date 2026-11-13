import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  initializeDevWorkspace,
  findDevWorkspace,
  readDevWorkspace,
  workspaceFolder,
  type DevWorkspaceConfig,
} from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, link: vi.fn(fs.link), open: vi.fn(fs.open) }
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
  vi.mocked(link).mockReset()
  vi.mocked(open).mockReset()
})

describe('initializeDevWorkspace', () => {
  it.each([
    ['typescript', 'agent.ts'],
    ['typescript', 'agent.mts'],
    ['typescript', 'agent.js'],
    ['typescript', 'agent.mjs'],
    ['python', 'agent.py'],
  ] as const)('should persist portable metadata When the %s entrypoint is %s', async (language, entrypoint) => {
    const root = await project(entrypoint)
    await mkdir(join(root, 'vendor', 'harness'), { recursive: true })
    const input = config({ language, entrypoint, harness: { path: 'vendor\\harness', version: '0.3.4' } })

    const workspace = await initializeDevWorkspace(root, input)

    expect(workspace).toEqual({
      root,
      entrypoint: join(root, entrypoint),
      config: { ...input, harness: { path: 'vendor/harness', version: '0.3.4' } },
    })
    expect(await readDevWorkspace(root)).toEqual(workspace)
    expect(JSON.parse(await readFile(join(root, '.strands', 'config.json'), 'utf8'))).toEqual(workspace.config)
    expect(await readFile(join(root, entrypoint), 'utf8')).toBe('unexecuted source')
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('/.strands/state/\n/.strands/reports/\n')
    expect(await readdir(join(root, '.strands'))).toEqual(['cases', 'config.json', 'state'])
    if (process.platform !== 'win32') {
      for (const path of ['.strands', '.strands/cases', '.strands/state']) {
        expect((await lstat(join(root, path))).mode & 0o777).toBe(0o700)
      }
      expect((await lstat(join(root, '.strands/config.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('should normalize nested entrypoints When the caller supplies portable Windows separators', async () => {
    const root = await project()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'agent.ts'), 'source')

    expect(await initializeDevWorkspace(root, config({ entrypoint: 'src\\agent.ts' }))).toMatchObject({
      entrypoint: join(root, 'src', 'agent.ts'),
      config: { entrypoint: 'src/agent.ts' },
    })
  })

  it.each(['cli', 'created', 'discovered'] as const)(
    'should retain origin fields When the kind is %s',
    async (kind) => {
      const root = await project()
      const origin = { kind, source: '@strands-agents/harness', version: '0.3.4' }

      expect((await initializeDevWorkspace(root, config({ origin }))).config.origin).toEqual(origin)
    }
  )

  it.each([
    ['existing\n', 'existing\n/.strands/state/\n/.strands/reports/\n'],
    ['existing', 'existing\n/.strands/state/\n/.strands/reports/\n'],
    ['existing\r\n/.strands/state/\r\n', 'existing\r\n/.strands/state/\r\n/.strands/reports/\r\n'],
    ['/.strands/reports/\n/.strands/state/\n', '/.strands/reports/\n/.strands/state/\n'],
    ['custom-ü\n', 'custom-ü\n/.strands/state/\n/.strands/reports/\n'],
  ])('should preserve existing ignore bytes When .gitignore contains %j', async (before, after) => {
    const root = await project()
    await writeFile(join(root, '.gitignore'), before)

    await initializeDevWorkspace(root, config())

    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(after)
  })

  it('should return the saved workspace without changes When its entrypoint matches', async () => {
    const root = await project()
    const saved = await initializeDevWorkspace(root, config())
    const before = await readFile(join(root, '.strands', 'config.json'))
    await writeFile(join(root, '.strands', 'cases', 'case.json'), 'existing case')
    vi.mocked(link).mockClear()

    const reopened = await initializeDevWorkspace(root, config({ name: 'Not saved', origin: { kind: 'cli' } }))

    expect(reopened).toEqual(saved)
    expect(await readFile(join(root, '.strands', 'config.json'))).toEqual(before)
    expect(await readFile(join(root, '.strands', 'cases', 'case.json'), 'utf8')).toBe('existing case')
    expect(link).not.toHaveBeenCalled()
  })

  it('should reject without overwriting metadata When another entrypoint is already selected', async () => {
    const root = await project()
    await initializeDevWorkspace(root, config())
    await writeFile(join(root, 'other.ts'), 'other source')
    const before = await readFile(join(root, '.strands', 'config.json'))

    await expect(initializeDevWorkspace(root, config({ entrypoint: 'other.ts' }))).rejects.toThrow(
      'different entrypoint'
    )

    expect(await readFile(join(root, '.strands', 'config.json'))).toEqual(before)
    expect(await readFile(join(root, 'other.ts'), 'utf8')).toBe('other source')
  })

  it('should keep malformed metadata untouched When initialization encounters an existing manifest', async () => {
    const root = await project()
    await mkdir(join(root, '.strands'))
    await writeFile(join(root, '.strands', 'config.json'), '{unfinished')

    await expect(initializeDevWorkspace(root, config())).rejects.toThrow()

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
    ['oversized name', { name: 'x'.repeat(65536) }],
    ['origin source', { origin: { kind: 'cli', source: false } }],
    ['origin version', { origin: { kind: 'cli', version: '' } }],
    ['harness', { harness: [] }],
    ['harness version', { harness: { path: 'vendor', version: 1 } }],
    ['harness path', { harness: { path: '../vendor', version: '1' } }],
  ])('should reject before making changes When %s is invalid', async (_field, overrides) => {
    const root = await project()

    await expect(initializeDevWorkspace(root, { ...config(), ...overrides } as DevWorkspaceConfig)).rejects.toThrow()

    expect(await readdir(root)).toEqual(['agent.ts'])
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

    await expect(initializeDevWorkspace(root, config({ entrypoint }))).rejects.toThrow()

    expect(await readdir(root)).toEqual(['agent.ts'])
  })

  it.each(['entrypoint', 'parent', 'harness'] as const)(
    'should reject symlinked paths When the link is the %s',
    async (kind) => {
      const root = await project()
      const outside = await project()
      let input: DevWorkspaceConfig
      if (kind === 'entrypoint') {
        await symlink(join(outside, 'agent.ts'), join(root, 'linked.ts'), 'file')
        input = config({ entrypoint: 'linked.ts' })
      } else {
        await symlink(outside, join(root, 'linked'), 'dir')
        input =
          kind === 'parent'
            ? config({ entrypoint: 'linked/agent.ts' })
            : config({ harness: { path: 'linked', version: '1' } })
      }

      await expect(initializeDevWorkspace(root, input)).rejects.toThrow('symbolic link')

      await expect(lstat(join(root, '.strands'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(outside)).toEqual(['agent.ts'])
    }
  )

  it('should reject internal symlinks When their target is still inside the root', async () => {
    const root = await project()
    await symlink(join(root, 'agent.ts'), join(root, 'linked.ts'), 'file')

    await expect(initializeDevWorkspace(root, config({ entrypoint: 'linked.ts' }))).rejects.toThrow('symbolic link')
  })

  it.each(['.strands', '.strands/cases', '.strands/state', '.strands/reports', '.strands/config.json', '.gitignore'])(
    'should reject dangerous metadata links When %s is a symlink',
    async (path) => {
      const root = await project()
      const outside = await project()
      const file = path.endsWith('json') || path === '.gitignore'
      if (path.startsWith('.strands/')) await mkdir(join(root, '.strands'))
      await symlink(file ? join(outside, 'agent.ts') : outside, join(root, path), file ? 'file' : 'dir')

      await expect(initializeDevWorkspace(root, config())).rejects.toThrow('symbolic link')

      expect(await readFile(join(outside, 'agent.ts'), 'utf8')).toBe('unexecuted source')
      expect(await readdir(outside)).toEqual(['agent.ts'])
    }
  )

  it('should reject hard-linked ignore files When changes would affect another path', async () => {
    const root = await project()
    await actualFs.link(join(root, 'agent.ts'), join(root, '.gitignore'))

    await expect(initializeDevWorkspace(root, config())).rejects.toThrow('hard-linked')

    expect(await readFile(join(root, 'agent.ts'), 'utf8')).toBe('unexecuted source')
    await expect(lstat(join(root, '.strands'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('should make preexisting metadata directories private When they are reused', async () => {
    const root = await project()
    for (const path of ['.strands', '.strands/cases', '.strands/state']) {
      await mkdir(join(root, path))
      await chmod(join(root, path), 0o755)
    }

    await initializeDevWorkspace(root, config())

    if (process.platform !== 'win32') expect((await lstat(join(root, '.strands/state'))).mode & 0o777).toBe(0o700)
  })

  it('should remove staging and leave no manifest When a staged write fails after partial output', async () => {
    const root = await project()
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actualFs.open(...args)
      const write = file.writeFile.bind(file)
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
        await write('{partial')
        throw new Error('disk full')
      })
      return file
    })

    await expect(initializeDevWorkspace(root, config())).rejects.toThrow('disk full')

    expect(await readdir(root)).toEqual(['agent.ts'])
  })

  it('should leave source and ignores unchanged When publishing the staged manifest fails', async () => {
    const root = await project()
    await writeFile(join(root, '.gitignore'), 'custom')
    vi.mocked(link).mockRejectedValueOnce(new Error('publish denied'))

    await expect(initializeDevWorkspace(root, config())).rejects.toThrow('publish denied')

    expect(await readdir(root)).toEqual(['.gitignore', 'agent.ts'])
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('custom')
    expect(await readFile(join(root, 'agent.ts'), 'utf8')).toBe('unexecuted source')
  })

  it.each([false, true])(
    'should roll back its manifest and ignore append When writing ignores fails with existing=%s',
    async (existing) => {
      const root = await project()
      if (existing) await writeFile(join(root, '.gitignore'), 'custom-ü')
      vi.mocked(open).mockImplementation(async (...args) => {
        const file = await actualFs.open(...args)
        if (String(args[0]).endsWith('.gitignore') && typeof args[1] === 'number' && args[1] & constants.O_RDWR) {
          const write = file.writeFile.bind(file)
          vi.spyOn(file, 'writeFile').mockImplementationOnce(async (contents) => {
            await write(String(contents).slice(0, 8))
            throw new Error('append failed')
          })
        }
        return file
      })

      await expect(initializeDevWorkspace(root, config())).rejects.toThrow('append failed')

      expect(await readdir(root)).toEqual(existing ? ['.gitignore', 'agent.ts'] : ['agent.ts'])
      if (existing) expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('custom-ü')
    }
  )

  it.each([false, true])('should preserve raw ignore bytes When appending fails=%s', async (fails) => {
    const root = await project()
    const contents = Buffer.from([0xff, 0x80, 0x0a])
    await writeFile(join(root, '.gitignore'), contents)
    if (fails) {
      vi.mocked(open).mockImplementation(async (...args) => {
        const file = await actualFs.open(...args)
        if (String(args[0]).endsWith('.gitignore') && typeof args[1] === 'number' && args[1] & constants.O_RDWR) {
          const write = file.writeFile.bind(file)
          vi.spyOn(file, 'writeFile').mockImplementationOnce(async (addition) => {
            await write(Buffer.from(String(addition)).subarray(0, 7))
            throw new Error('partial append')
          })
        }
        return file
      })
      await expect(initializeDevWorkspace(root, config())).rejects.toThrow('partial append')
    } else {
      await initializeDevWorkspace(root, config())
    }

    const expected = fails ? contents : Buffer.concat([contents, Buffer.from('/.strands/state/\n/.strands/reports/\n')])
    expect(await readFile(join(root, '.gitignore'))).toEqual(expected)
  })

  it('should preserve concurrent ignore edits When initialization detects changed contents', async () => {
    const root = await project()
    await writeFile(join(root, '.gitignore'), 'before\n')
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await actualFs.link(source, destination)
      await writeFile(join(root, '.gitignore'), 'concurrent edit\n')
    })

    await expect(initializeDevWorkspace(root, config())).rejects.toThrow('changed during workspace initialization')

    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('concurrent edit\n')
    await expect(lstat(join(root, '.strands/config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('should not overwrite a conflicting concurrent manifest When its entrypoint differs', async () => {
    const root = await project()
    await writeFile(join(root, 'other.ts'), 'other')
    const winner = config({ entrypoint: 'other.ts' })
    vi.mocked(link).mockImplementationOnce(async (_source, destination) => {
      await writeFile(destination, JSON.stringify(winner), { flag: 'wx' })
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    })

    await expect(initializeDevWorkspace(root, config())).rejects.toThrow('different entrypoint')

    expect(JSON.parse(await readFile(join(root, '.strands/config.json'), 'utf8'))).toEqual(winner)
    expect(await readdir(join(root, '.strands'))).toEqual(['cases', 'config.json', 'state'])
  })

  it('should not overwrite a competing manifest When another initializer wins publication', async () => {
    const root = await project()
    const winner = config({ name: 'Concurrent winner' })
    vi.mocked(link).mockImplementationOnce(async (_source, destination) => {
      await writeFile(destination, JSON.stringify(winner), { flag: 'wx' })
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    })

    expect((await initializeDevWorkspace(root, config())).config).toEqual(winner)
    expect(JSON.parse(await readFile(join(root, '.strands/config.json'), 'utf8'))).toEqual(winner)
    expect(await readdir(join(root, '.strands'))).toEqual(['cases', 'config.json', 'state'])
  })
})

describe('readDevWorkspace', () => {
  it('should return undefined When only the manifest is missing', async () => {
    const root = await project()

    expect(await readDevWorkspace(root)).toBeUndefined()
    expect(await readDevWorkspace(join(root, 'missing'))).toBeUndefined()
  })

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

  it.each([
    config({ version: 2 } as unknown as Partial<DevWorkspaceConfig>),
    config({ name: '' }),
    config({ entrypoint: '../agent.ts' }),
  ])('should reject malformed metadata When the document is %j', async (document) => {
    const root = await project()
    await manifest(root, document)

    await expect(readDevWorkspace(root)).rejects.toThrow()
  })

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

  it('should reject symbolic root directories When opening or initializing a workspace', async () => {
    const parent = await temporaryDirectory()
    const root = await project()
    const path = join(parent, 'linked')
    await symlink(root, path, 'dir')

    await expect(readDevWorkspace(path)).rejects.toThrow('symbolic link')
    await expect(initializeDevWorkspace(path, config())).rejects.toThrow('symbolic link')
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

  it('shouldFindNoWorkspaceWhenTheFolderHoldsAnUnrelatedConfigFolder', async () => {
    const path = await temporaryDirectory()
    await mkdir(join(path, '.config'))

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
