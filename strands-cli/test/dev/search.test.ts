import { lstat, mkdir, open, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { discoverHarnesses } from '../../src/dev/search.js'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import { importAgentProject } from '../../src/project/import.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('../../src/project/import.js', () => ({
  importAgentProject: vi.fn((path: string) => ({
    root: dirname(path),
    entrypoint: path,
    language: path.endsWith('.py') ? 'python' : 'typescript',
  })),
}))

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    lstat: vi.fn(fs.lstat),
    open: vi.fn(fs.open),
    readdir: vi.fn(fs.readdir),
    realpath: vi.fn(fs.realpath),
  }
})

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const typescriptSource =
  "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Helpful harness' })"
const pythonSource = "from strands_harness import create_harness\nagent = create_harness(name='Helpful harness')"

async function directory() {
  return realpath(await temporaryDirectory())
}

async function sourceFile(root: string, path: string, source = typescriptSource) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, source)
  return target
}

afterEach(() => vi.resetAllMocks())

describe('discoverHarnesses', () => {
  it.each(['ts', 'mts', 'js', 'mjs'])(
    'should discover a named harness When an agent is constructed in a %s file',
    async (extension) => {
      const root = await directory()
      const entrypoint = await sourceFile(root, `assistant.${extension}`)

      expect(await discoverHarnesses([root])).toEqual({
        harnesses: [{ name: 'Helpful harness', entrypoint, root, language: 'typescript' }],
        warnings: [],
      })
      expect(importAgentProject).toHaveBeenCalledWith(entrypoint)
    }
  )

  it.each([
    "import { createHarness as build } from '@strands-agents/harness'; export const agent = await build({ name: 'Alias' })",
    "import * as harness from '@strands-agents/harness'; export const agent = harness.createHarness({ name: 'Alias' })",
    "import { createHarness } from '@strands-agents/harness'; const agent = createHarness({ name: `Alias` }); export { agent }",
    "import { createHarness } from '@strands-agents/harness'; const agent = createHarness({ 'name': 'Alias' })",
  ])('should resolve imported constructors When the source uses %s', async (source) => {
    const root = await directory()
    await sourceFile(root, 'agent.ts', source)

    expect((await discoverHarnesses([root])).harnesses).toMatchObject([{ name: 'Alias' }])
  })

  it.each([
    ["from strands_harness import create_harness\nagent = create_harness(name='Python harness')", 'Python harness'],
    ["from strands_harness import create_harness as build\nagent = build(name='Alias')", 'Alias'],
    ["import strands_harness as harness\nagent = harness.create_harness(name='Namespace')", 'Namespace'],
    ["import strands_harness\nagent = strands_harness.create_harness(name='Module')", 'Module'],
    [
      "from strands_harness import (\n    create_harness as build,\n)\nagent: Agent = build(\n    name='Multiline',\n)",
      'Multiline',
    ],
    ["from strands_harness import create_harness\nagent = create_harness(name=r'Raw name')", 'Raw name'],
    ["from strands_harness import create_harness\nagent = create_harness(name='''Long name''')", 'Long name'],
    ['from strands_harness import create_harness\nagent = create_harness()', 'agent.py'],
    ['from strands_harness import create_harness\nagent = create_harness(name=dynamic_name)', 'agent.py'],
    ["from strands_harness import create_harness\nagent = create_harness(name=f'{dynamic_name}')", 'agent.py'],
  ])('should inspect Python without execution When source is %s', async (source, name) => {
    const root = await directory()
    const entrypoint = await sourceFile(root, 'agent.py', source)

    expect(await discoverHarnesses([root])).toEqual({
      harnesses: [{ name, entrypoint, root, language: 'python' }],
      warnings: [],
    })
  })

  it.each([
    ["import { Agent } from '@strands-agents/sdk'; export const agent = new Agent({})", 'ts'],
    ["import { Agent } from '@strands-agents/harness'; export const agent = new Agent({})", 'ts'],
    ["import { createHarness } from 'other-library'; export const agent = createHarness({})", 'ts'],
    ["import type { createHarness } from '@strands-agents/harness'; const agent = createHarness({})", 'ts'],
    ["import { type createHarness } from '@strands-agents/harness'; const agent = createHarness({})", 'ts'],
    [
      "import { createHarness } from '@strands-agents/harness'; function example() { const agent = createHarness({}) }",
      'ts',
    ],
    ["import { createHarness } from '@strands-agents/harness'; export const other = createHarness({})", 'ts'],
    ["import { createHarness } from '@strands-agents/harness'; export const agent = new Agent({})", 'ts'],
    ['from strands import Agent\nagent = Agent()', 'py'],
    ['from other_library import create_harness\nagent = create_harness()', 'py'],
    ['from strands_harness import Agent\nagent = Agent()', 'py'],
    ['from strands_harness import create_harness\ndef example():\n    agent = create_harness()', 'py'],
    ['from strands_harness import create_harness\ndef example():\n    before = 1; agent = create_harness()', 'py'],
    ['from strands_harness import create_harness\ndef example(): before = 1; agent = create_harness()', 'py'],
    ['from strands_harness import create_harness\nif False: before = 1; agent = create_harness()', 'py'],
    ['from strands_harness import create_harness\nother = create_harness()', 'py'],
    ['from strands_harness import create_harness\nagent = not_harness(create_harness())', 'py'],
    ['from strands_harness import create_harness\nagent = create_harness() or other()', 'py'],
  ])('should not offer non-harness or local agents When source is %s', async (source, extension) => {
    const root = await directory()
    await sourceFile(root, `agent.${extension}`, source)

    expect(await discoverHarnesses([root])).toEqual({ harnesses: [], warnings: [] })
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it.each([
    ['ts', `/* ${typescriptSource} */`],
    [
      'ts',
      typescriptSource
        .split('\n')
        .map((line) => `// ${line}`)
        .join('\n'),
    ],
    ['ts', `const example = ${JSON.stringify(typescriptSource)}`],
    ['ts', `const example = \`${typescriptSource}\``],
    [
      'py',
      pythonSource
        .split('\n')
        .map((line) => `# ${line}`)
        .join('\n'),
    ],
    ['py', `"""${pythonSource}"""`],
    ['py', `example = r'''${pythonSource}'''`],
    ['py', `example = f'''${pythonSource}'''`],
    [
      'py',
      `example = '${pythonSource.replaceAll('\n', '\\n')}'`.replaceAll(
        "name='Helpful harness'",
        'name="Helpful harness"'
      ),
    ],
  ])('should ignore strings and comments When the %s file contains %s', async (extension, source) => {
    const root = await directory()
    await sourceFile(root, `example.${extension}`, source)

    expect(await discoverHarnesses([root])).toEqual({ harnesses: [], warnings: [] })
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it.each([
    'createHarness()',
    'createHarness({ name: computed })',
    "createHarness({ name: 'Hidden', ...options })",
    "createHarness({ name: 'Hidden', [key]: value })",
    'createHarness({ name: `Dynamic ${suffix}` })',
    "createHarness({ name: '' })",
    "createHarness({ name: '\\u001b[31m' })",
  ])('should fall back to the filename When the call is %s', async (call) => {
    const root = await directory()
    await sourceFile(
      root,
      'assistant.ts',
      `import { createHarness } from '@strands-agents/harness'; const agent = ${call}`
    )

    expect((await discoverHarnesses([root])).harnesses).toMatchObject([{ name: 'assistant.ts' }])
  })

  it.each([
    '.git',
    'node_modules',
    '.venv',
    'venv',
    '__pycache__',
    'dist',
    'build',
    '.strands/state',
    '.strands/reports',
    '.strands/cases',
    '.strands/runtime',
  ])('should exclude generated and private trees When agents occur in %s', async (ignored) => {
    const root = await directory()
    await sourceFile(root, `${ignored}/agent.ts`)

    expect(await discoverHarnesses([root, join(root, ignored)])).toEqual({ harnesses: [], warnings: [] })
  })

  it('should select the established project root When the importer returns a parent directory', async () => {
    const root = await directory()
    const entrypoint = await sourceFile(root, 'src/agent.ts')
    await writeFile(join(root, 'package.json'), '{"name":"example"}')
    vi.mocked(importAgentProject).mockReturnValueOnce({ root, entrypoint, language: 'typescript' })

    expect((await discoverHarnesses([root])).harnesses).toEqual([
      { name: 'Helpful harness', root, entrypoint, language: 'typescript' },
    ])
  })

  it('should deduplicate and sort entrypoints When recursive roots overlap or repeat', async () => {
    const root = await directory()
    const first = await sourceFile(root, 'a/agent.py', pythonSource)
    const second = await sourceFile(root, 'z/agent.ts')
    const roots = [join(root, 'z'), root, first, root]

    const result = await discoverHarnesses(roots)

    expect(result.harnesses.map((harness) => harness.entrypoint)).toEqual([first, second])
    expect(result.warnings).toEqual([])
    expect(importAgentProject).toHaveBeenCalledTimes(2)
    expect((await discoverHarnesses([...roots].reverse())).harnesses).toEqual(result.harnesses)
  })

  it('should honor manifests and discover nested workspaces When vendored harness sources also contain agents', async () => {
    const root = await directory()
    const outerEntry = await sourceFile(root, 'agent.ts', 'not a statically detectable harness')
    await sourceFile(root, 'vendor/harness/example.ts')
    const outer = await initializeDevWorkspace(root, {
      version: 1,
      name: 'Outer workspace',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'cli' },
      harness: { path: 'vendor/harness', version: '0.3.4' },
    })
    const innerEntry = await sourceFile(root, 'nested/agent.py', pythonSource)
    const inner = await initializeDevWorkspace(dirname(innerEntry), {
      version: 1,
      name: 'Nested workspace',
      language: 'python',
      entrypoint: 'agent.py',
      origin: { kind: 'created' },
    })

    expect(await discoverHarnesses([root])).toEqual({
      harnesses: [
        { name: 'Outer workspace', root, entrypoint: outerEntry, language: 'typescript', workspace: outer },
        { name: 'Nested workspace', root: inner.root, entrypoint: innerEntry, language: 'python', workspace: inner },
      ],
      warnings: [],
    })
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it('should keep scanning with a warning When workspace metadata is malformed', async () => {
    const root = await directory()
    await sourceFile(root, 'agent.ts')
    await sourceFile(root, '.strands/config.json', '{broken')

    const result = await discoverHarnesses([root])

    expect(result.harnesses).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(join(root, '.strands/config.json'))
  })

  it('should ignore linked files and directories When they point at candidates outside the search roots', async () => {
    const root = await directory()
    const outside = await directory()
    const agent = await sourceFile(outside, 'agent.ts')
    await symlink(agent, join(root, 'linked.ts'), 'file')
    await symlink(outside, join(root, 'linked'), 'dir')
    await symlink(root, join(root, 'cycle'), 'dir')

    expect(await discoverHarnesses([root])).toEqual({ harnesses: [], warnings: [] })
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it('should warn for explicit symbolic paths When the path or an ancestor is linked', async () => {
    const root = await directory()
    const outside = await directory()
    await sourceFile(outside, 'agent.ts')
    await symlink(outside, join(root, 'linked'), 'dir')

    const result = await discoverHarnesses([join(root, 'linked'), join(root, 'linked/agent.ts')])

    expect(result.harnesses).toEqual([])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.every((warning) => warning.includes('symbolic link'))).toBe(true)
  })

  it('should report unusable roots When paths are empty, absent, or unsupported', async () => {
    const root = await directory()
    const text = await sourceFile(root, 'readme.txt', '')

    const result = await discoverHarnesses(['', join(root, 'missing'), text])

    expect(result.harnesses).toEqual([])
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.join('\n')).toContain('missing')
    expect(result.warnings.join('\n')).toContain('readme.txt')
    expect(await discoverHarnesses([])).toEqual({ harnesses: [], warnings: [] })
  })

  it('should warn without importing candidates When a source exceeds the size bound', async () => {
    const root = await directory()
    const entrypoint = await sourceFile(root, 'agent.ts', typescriptSource + '\n' + ' '.repeat(1024 * 1024))

    const result = await discoverHarnesses([root])

    expect(result.harnesses).toEqual([])
    expect(result.warnings[0]).toContain(entrypoint)
    expect(result.warnings[0]).toContain('1048576')
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it('should bound project metadata reads When an ancestor package manifest is huge', async () => {
    const root = await directory()
    await sourceFile(root, 'src/agent.ts')
    await sourceFile(root, 'package.json', ' '.repeat(1024 * 1024 + 1))

    const result = await discoverHarnesses([root])

    expect(result.harnesses).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it.each([
    ['ts', "import { createHarness } from '@strands-agents/harness'; export const agent = createHarness({"],
    ['py', 'from strands_harness import create_harness\nagent = create_harness('],
    ['py', "from strands_harness import create_harness\nagent = create_harness(name='unfinished)"],
  ])('should warn instead of silently dropping syntax failures When %s source is %s', async (extension, source) => {
    const root = await directory()
    const entrypoint = await sourceFile(root, `broken.${extension}`, source)

    const result = await discoverHarnesses([root])

    expect(result.harnesses).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(entrypoint)
  })

  it('should warn and continue other candidates When project root selection fails', async () => {
    const root = await directory()
    const broken = await sourceFile(root, 'a.ts')
    const healthy = await sourceFile(root, 'b.ts')
    vi.mocked(importAgentProject).mockImplementationOnce(() => {
      throw new Error('bad package metadata')
    })

    const result = await discoverHarnesses([root])

    expect(result.harnesses.map((harness) => harness.entrypoint)).toEqual([healthy])
    expect(result.warnings).toEqual([`${broken}: bad package metadata`])
  })

  it('should report denied directory reads When a search root is inaccessible', async () => {
    const root = await directory()
    vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error('directory denied'), { code: 'EACCES' }))

    expect(await discoverHarnesses([root])).toEqual({ harnesses: [], warnings: [`${root}: directory denied`] })
  })

  it('should report denied source reads When a regular file cannot be opened', async () => {
    const root = await directory()
    const entrypoint = await sourceFile(root, 'agent.ts')
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('file denied'), { code: 'EACCES' }))

    expect(await discoverHarnesses([root])).toEqual({ harnesses: [], warnings: [`${entrypoint}: file denied`] })
  })

  it('should guard source identity before reading When a file changes during open', async () => {
    const root = await directory()
    const entrypoint = await sourceFile(root, 'agent.ts')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actualFs.open(...args)
      const details = await file.stat()
      vi.spyOn(file, 'stat').mockResolvedValue(Object.assign(details, { ino: details.ino + 1 }))
      return file
    })

    const result = await discoverHarnesses([root])

    expect(result.harnesses).toEqual([])
    expect(result.warnings[0]).toContain(entrypoint)
    expect(importAgentProject).not.toHaveBeenCalled()
  })

  it('should detect harnesses without importing modules When top-level statements would throw', async () => {
    const root = await directory()
    await sourceFile(root, 'agent.ts', `${typescriptSource}\nthrow new Error('must not execute')`)
    await sourceFile(root, 'agent.py', `${pythonSource}\nraise RuntimeError('must not execute')`)

    expect((await discoverHarnesses([root])).harnesses).toHaveLength(2)
    expect(await readdir(root)).toEqual(['agent.py', 'agent.ts'])
  })

  it('should warn about unsafe workspace metadata When .strands points outside the root', async () => {
    const root = await directory()
    const outside = await directory()
    await symlink(outside, join(root, '.strands'), 'dir')

    const result = await discoverHarnesses([root])

    expect(result.harnesses).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('symbolic link')
    expect(await readdir(outside)).toEqual([])
  })

  it('should warn on failed stats When a candidate disappears during scanning', async () => {
    const root = await directory()
    const entrypoint = await sourceFile(root, 'agent.ts')
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === entrypoint) throw Object.assign(new Error('source disappeared'), { code: 'ENOENT' })
      return actualFs.lstat(...args)
    })

    expect(await discoverHarnesses([root])).toEqual({ harnesses: [], warnings: [`${entrypoint}: source disappeared`] })
  })
})
