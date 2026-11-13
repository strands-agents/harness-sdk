import { execFileSync } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bindWorkspace, readWorkspaceBinding, type WorkspaceBinding } from '../../src/dev/binding.js'

let sandbox: string
let directory: string
let agentRoot: string
let binding: WorkspaceBinding

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'strands-binding-'))
  directory = join(sandbox, 'workspace')
  agentRoot = join(directory, 'agent')
  await mkdir(agentRoot, { recursive: true })
  await writeFile(join(agentRoot, 'agent.ts'), 'export const agent = {}\n')
  binding = {
    version: 1,
    name: 'My agent',
    agent: { path: 'agent', entrypoint: 'agent.ts', language: 'typescript' },
    origin: { kind: 'created' },
  }
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

async function store(document: unknown): Promise<void> {
  await writeFile(join(directory, '.config'), JSON.stringify(document))
}

async function expectUnbound(): Promise<void> {
  expect(await readdir(directory)).toEqual(['agent'])
  expect(await readFile(join(agentRoot, 'agent.ts'), 'utf8')).toBe('export const agent = {}\n')
}

describe('workspace bindings', () => {
  it('returns undefined without creating metadata when no binding exists', async () => {
    expect(await readWorkspaceBinding(directory)).toBeUndefined()
    expect(await readWorkspaceBinding(join(sandbox, 'missing'))).toBeUndefined()
    await expectUnbound()
    expect(await readdir(sandbox)).toEqual(['workspace'])
  })

  it('binds an internal project with a private temporary directory and stable schema', async () => {
    binding.origin = { kind: 'cli', source: 'selected-agent', version: '1.2.3' }
    binding.harness = { path: '../harness', version: '2.3.4' }
    const result = await bindWorkspace(directory, binding)
    expect(result).toEqual({ directory, agentRoot, entrypoint: join(agentRoot, 'agent.ts'), binding })
    expect(await readWorkspaceBinding(directory)).toEqual(result)
    expect(JSON.parse(await readFile(join(directory, '.config'), 'utf8'))).toEqual(binding)
    expect((await stat(join(directory, '.config'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'tmp'))).mode & 0o777).toBe(0o700)
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('/tmp/\n')
    expect(await readdir(directory)).toEqual(['.config', '.gitignore', 'agent', 'tmp'])
    expect(await readdir(agentRoot)).toEqual(['agent.ts'])
  })

  it.each(['../external', 'absolute'])('binds an external project through %s without moving it', async (path) => {
    const external = join(sandbox, 'external')
    await mkdir(external)
    await writeFile(join(external, 'agent.py'), 'agent = object()\n')
    binding.agent = { path: path === 'absolute' ? external : path, entrypoint: 'agent.py', language: 'python' }
    binding.origin = { kind: 'discovered', source: external }
    const result = await bindWorkspace(directory, binding)
    expect(result.agentRoot).toBe(external)
    expect(result.entrypoint).toBe(join(external, 'agent.py'))
    expect(await readWorkspaceBinding(directory)).toEqual(result)
    expect(await readdir(external)).toEqual(['agent.py'])
    expect(await readFile(join(external, 'agent.py'), 'utf8')).toBe('agent = object()\n')
  })

  it.each(['ts', 'mts', 'js', 'mjs'])(
    'accepts supported TypeScript project entrypoints ending in %s',
    async (extension) => {
      binding.agent.entrypoint = `nested/main.${extension}`
      await mkdir(join(agentRoot, 'nested'))
      await writeFile(join(agentRoot, binding.agent.entrypoint), 'export const agent = {}')
      expect((await bindWorkspace(directory, binding)).entrypoint).toBe(join(agentRoot, binding.agent.entrypoint))
    }
  )

  it('allows the workspace itself to be the project root while keeping tmp off limits', async () => {
    binding.agent.path = '.'
    binding.agent.entrypoint = 'agent/agent.ts'
    expect((await bindWorkspace(directory, binding)).agentRoot).toBe(directory)
  })

  it('reads existing metadata without creating tmp or gitignore', async () => {
    await store(binding)
    expect((await readWorkspaceBinding(directory))?.binding).toEqual(binding)
    expect(await readdir(directory)).toEqual(['.config', 'agent'])
  })

  it('requires an existing workspace root', async () => {
    const missing = join(sandbox, 'missing')
    await expect(bindWorkspace(missing, binding)).rejects.toThrow(missing)
    expect(await readdir(sandbox)).toEqual(['workspace'])
  })

  it.each(['logs/', 'logs/\n', 'logs/\r\n', '/tmp/\nlogs/\n'])(
    'preserves ignore contents %j and appends only when needed',
    async (contents) => {
      await writeFile(join(directory, '.gitignore'), contents)
      await bindWorkspace(directory, binding)
      const expected = contents.includes('/tmp/')
        ? contents
        : `${contents}${contents.endsWith('\n') ? '' : '\n'}/tmp/${contents.includes('\r\n') ? '\r\n' : '\n'}`
      expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe(expected)
      await bindWorkspace(directory, binding)
      expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe(expected)
    }
  )

  it('keeps existing temporary files and makes the temporary directory private', async () => {
    await mkdir(join(directory, 'tmp'))
    await chmod(join(directory, 'tmp'), 0o755)
    await writeFile(join(directory, 'tmp', 'keep'), 'kept')
    await bindWorkspace(directory, binding)
    expect(await readFile(join(directory, 'tmp', 'keep'), 'utf8')).toBe('kept')
    expect((await stat(join(directory, 'tmp'))).mode & 0o777).toBe(0o700)
  })

  it('returns the existing binding unchanged when the resolved target matches', async () => {
    await store(binding)
    const before = await readFile(join(directory, '.config'))
    const requested = { ...binding, name: 'Other name', agent: { ...binding.agent, path: agentRoot } }
    expect((await bindWorkspace(directory, requested)).binding).toEqual(binding)
    expect(await readFile(join(directory, '.config'))).toEqual(before)
    expect(await readdir(directory)).toEqual(['.config', 'agent'])
  })

  it('refuses to replace an existing binding for a different target', async () => {
    await store(binding)
    await writeFile(join(agentRoot, 'other.ts'), 'other')
    const before = await readFile(join(directory, '.config'))
    binding.agent.entrypoint = 'other.ts'
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('already binds a different agent')
    expect(await readFile(join(directory, '.config'))).toEqual(before)
    expect(await readdir(directory)).toEqual(['.config', 'agent'])
  })

  it('publishes only one complete binding when different targets race', async () => {
    await writeFile(join(agentRoot, 'other.ts'), 'other')
    const other = { ...binding, agent: { ...binding.agent, entrypoint: 'other.ts' } }
    const results = await Promise.allSettled([bindWorkspace(directory, binding), bindWorkspace(directory, other)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const winner = results.find((result) => result.status === 'fulfilled')
    expect(await readWorkspaceBinding(directory)).toEqual(winner?.status === 'fulfilled' ? winner.value : undefined)
    expect(await readdir(directory)).toEqual(['.config', '.gitignore', 'agent', 'tmp'])
  })

  it('handles simultaneous requests for the same target without overwriting the winner', async () => {
    const results = await Promise.all([bindWorkspace(directory, binding), bindWorkspace(directory, binding)])
    expect(results[0]).toEqual(results[1])
    expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('/tmp/\n')
    expect(await readdir(directory)).toEqual(['.config', '.gitignore', 'agent', 'tmp'])
  })
})

describe('invalid workspace bindings', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['unknown version', { version: 2 }],
    ['missing version', {}],
    ['empty name', { name: ' ' }],
    ['control in name', { name: 'agent\nname' }],
    ['missing agent', { agent: undefined }],
    ['empty agent path', { agent: { path: '', entrypoint: 'agent.ts', language: 'typescript' } }],
    ['unknown language', { agent: { path: 'agent', entrypoint: 'agent.ts', language: 'ruby' } }],
    ['wrong extension', { agent: { path: 'agent', entrypoint: 'agent.py', language: 'typescript' } }],
    ['unsupported extension', { agent: { path: 'agent', entrypoint: 'agent.txt', language: 'typescript' } }],
    ['absolute entrypoint', { agent: { path: 'agent', entrypoint: '/agent.ts', language: 'typescript' } }],
    ['windows entrypoint', { agent: { path: 'agent', entrypoint: 'C:\\agent.ts', language: 'typescript' } }],
    ['unknown origin', { origin: { kind: 'other' } }],
    ['non-string origin', { origin: { kind: ['cli'] } }],
    ['invalid source', { origin: { kind: 'cli', source: 42 } }],
    ['invalid origin version', { origin: { kind: 'cli', version: '' } }],
    ['invalid harness', { harness: null }],
    ['missing harness version', { harness: { path: '../harness' } }],
  ])('rejects %s in reads and writes without changing files', async (_name, patch) => {
    const invalid = patch === null || Array.isArray(patch) ? patch : { ...binding, ...patch }
    if (_name === 'missing version' && invalid && !Array.isArray(invalid))
      delete (invalid as { version?: number }).version
    await expect(bindWorkspace(directory, invalid as WorkspaceBinding)).rejects.toThrow(join(directory, '.config'))
    await expectUnbound()
    await store(invalid)
    const before = await readFile(join(directory, '.config'))
    await expect(readWorkspaceBinding(directory)).rejects.toThrow(join(directory, '.config'))
    await expect(bindWorkspace(directory, binding)).rejects.toThrow(join(directory, '.config'))
    expect(await readFile(join(directory, '.config'))).toEqual(before)
    expect(await readdir(directory)).toEqual(['.config', 'agent'])
  })

  it('reports unsupported versions explicitly', async () => {
    await store({ ...binding, version: 9 })
    await expect(readWorkspaceBinding(directory)).rejects.toThrow('Unsupported version 9; expected 1')
  })

  it.each(['{', '', 'x'.repeat(65537)])('rejects malformed or oversized config text of length %i', async (text) => {
    await writeFile(join(directory, '.config'), text)
    await expect(readWorkspaceBinding(directory)).rejects.toThrow(join(directory, '.config'))
    await expect(bindWorkspace(directory, binding)).rejects.toThrow(join(directory, '.config'))
    expect(await readFile(join(directory, '.config'), 'utf8')).toBe(text)
    expect(await readdir(directory)).toEqual(['.config', 'agent'])
  })

  it('rejects oversized bindings before creating files', async () => {
    binding.name = 'x'.repeat(65536)
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('65536 bytes')
    await expectUnbound()
  })

  it.each(['../outside.ts', 'missing.ts', 'folder.ts'])(
    'rejects an escaping, missing or non-file entrypoint %s',
    async (entrypoint) => {
      await writeFile(join(directory, 'outside.ts'), 'outside')
      await mkdir(join(agentRoot, 'folder.ts'))
      binding.agent.entrypoint = entrypoint
      await expect(bindWorkspace(directory, binding)).rejects.toThrow()
      expect(await readdir(directory)).toEqual(['agent', 'outside.ts'])
      await store(binding)
      await expect(readWorkspaceBinding(directory)).rejects.toThrow()
    }
  )

  it.each(['project', 'entrypoint'])('rejects a %s inside workspace tmp', async (target) => {
    await mkdir(join(directory, 'tmp'))
    await writeFile(join(directory, 'tmp', 'agent.ts'), 'temporary')
    binding.agent =
      target === 'project'
        ? { ...binding.agent, path: 'tmp' }
        : { ...binding.agent, path: '.', entrypoint: 'tmp/agent.ts' }
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('cannot target temporary files')
    await store(binding)
    await expect(readWorkspaceBinding(directory)).rejects.toThrow('cannot target temporary files')
  })

  it('allows projects whose directory name merely starts with tmp', async () => {
    await mkdir(join(directory, 'tmp-agent'))
    await writeFile(join(directory, 'tmp-agent', 'agent.ts'), 'persistent')
    binding.agent.path = 'tmp-agent'
    expect((await bindWorkspace(directory, binding)).agentRoot).toBe(join(directory, 'tmp-agent'))
  })

  it.each(['.config', 'tmp', '.gitignore'])('rejects a symlink at %s without changing its target', async (name) => {
    const target = join(sandbox, 'untouched')
    if (name === 'tmp') await mkdir(target)
    else await writeFile(target, name === '.config' ? JSON.stringify(binding) : 'keep\n')
    await symlink(target, join(directory, name))
    await expect(bindWorkspace(directory, binding)).rejects.toThrow(join(directory, name))
    if (name === '.config') await expect(readWorkspaceBinding(directory)).rejects.toThrow(join(directory, name))
    if (name === 'tmp') {
      expect(await readWorkspaceBinding(directory)).toBeUndefined()
      await store(binding)
      await expect(readWorkspaceBinding(directory)).rejects.toThrow(join(directory, name))
      await rm(join(directory, '.config'))
    }
    expect((await lstat(join(directory, name))).isSymbolicLink()).toBe(true)
    if (name === 'tmp') expect(await readdir(target)).toEqual([])
    else expect(await readFile(target, 'utf8')).toBe(name === '.config' ? JSON.stringify(binding) : 'keep\n')
    expect((await readdir(directory)).sort()).toEqual([name, 'agent'].sort())
  })

  it.each(['.config', 'tmp', '.gitignore'])('rejects the wrong metadata type at %s', async (name) => {
    if (name === 'tmp') await writeFile(join(directory, name), 'keep')
    else await mkdir(join(directory, name))
    await expect(bindWorkspace(directory, binding)).rejects.toThrow(join(directory, name))
    expect((await readdir(directory)).sort()).toEqual([name, 'agent'].sort())
  })

  it('rejects FIFO metadata without blocking', async () => {
    execFileSync('mkfifo', [join(directory, '.config')])
    await expect(readWorkspaceBinding(directory)).rejects.toThrow('regular file')
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('regular file')
  })

  it.each(['root', 'project', 'entrypoint', 'nested'])('rejects a symlink in the %s path', async (target) => {
    let root = directory
    if (target === 'root') {
      root = join(sandbox, 'linked-workspace')
      await symlink(directory, root)
    } else if (target === 'project') {
      await symlink(agentRoot, join(directory, 'alias'))
      binding.agent.path = 'alias'
    } else if (target === 'entrypoint') {
      await symlink(join(agentRoot, 'agent.ts'), join(agentRoot, 'alias.ts'))
      binding.agent.entrypoint = 'alias.ts'
    } else {
      await symlink(agentRoot, join(agentRoot, 'alias'))
      binding.agent.entrypoint = 'alias/agent.ts'
    }
    await expect(bindWorkspace(root, binding)).rejects.toThrow('symbolic link')
    await store(binding)
    await expect(readWorkspaceBinding(root)).rejects.toThrow('symbolic link')
    expect(await readdir(directory)).not.toContain('tmp')
  })

  it('shouldBindTheRealWorkspaceWhenAnAncestorDirectoryIsALinkSuchAsMacOsTmp', async () => {
    await symlink(sandbox, join(sandbox, 'alias'))
    const linked = join(sandbox, 'alias', 'workspace')

    const bound = await bindWorkspace(linked, binding)

    expect(bound.directory).toBe(directory)
    expect(bound.entrypoint).toBe(join(agentRoot, 'agent.ts'))
    expect(await readFile(join(directory, '.config'), 'utf8')).toContain('"version": 1')
    await expect(readWorkspaceBinding(linked)).resolves.toMatchObject({ directory })
    await expect(readWorkspaceBinding(directory)).resolves.toMatchObject({ directory })
  })

  it('shouldStillRefuseAnAgentOutsideTheWorkspaceWhenAnAncestorDirectoryIsALink', async () => {
    await symlink(sandbox, join(sandbox, 'alias'))
    await symlink(agentRoot, join(directory, 'escape'))

    await expect(
      bindWorkspace(join(sandbox, 'alias', 'workspace'), { ...binding, agent: { ...binding.agent, path: 'escape' } })
    ).rejects.toThrow('symbolic link')
    expect(await readdir(directory)).not.toContain('.config')
  })

  it('refuses to append to a hard-linked ignore file', async () => {
    const external = join(sandbox, 'ignore')
    await writeFile(external, 'keep\n')
    await link(external, join(directory, '.gitignore'))
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('Hard-linked metadata')
    expect(await readFile(external, 'utf8')).toBe('keep\n')
    expect(await readdir(directory)).toEqual(['.gitignore', 'agent'])
  })

  it('removes published metadata and staging files when an ignore append fails', async () => {
    const ignore = join(directory, '.gitignore')
    await writeFile(ignore, 'preserved\n')
    await chmod(ignore, 0o444)
    try {
      await expect(bindWorkspace(directory, binding)).rejects.toThrow()
      expect(await readFile(ignore, 'utf8')).toBe('preserved\n')
      expect(await readdir(directory)).toEqual(['.gitignore', 'agent'])
      expect(await readWorkspaceBinding(directory)).toBeUndefined()
    } finally {
      await chmod(ignore, 0o644)
    }
  })

  it('retains an existing temporary directory when binding fails after publication', async () => {
    await mkdir(join(directory, 'tmp'))
    await writeFile(join(directory, 'tmp', 'keep'), 'preserved')
    const ignore = join(directory, '.gitignore')
    await writeFile(ignore, 'preserved\n')
    await chmod(ignore, 0o444)
    try {
      await expect(bindWorkspace(directory, binding)).rejects.toThrow()
      expect(await readdir(directory)).toEqual(['.gitignore', 'agent', 'tmp'])
      expect(await readFile(join(directory, 'tmp', 'keep'), 'utf8')).toBe('preserved')
    } finally {
      await chmod(ignore, 0o644)
    }
  })

  it('reads a valid config exactly at the size limit', async () => {
    const contents = JSON.stringify(binding).padEnd(65536, ' ')
    await writeFile(join(directory, '.config'), contents)
    expect((await readWorkspaceBinding(directory))?.binding).toEqual(binding)
    expect(await readFile(join(directory, '.config'), 'utf8')).toBe(contents)
  })

  it('rejects an agent root that is not a directory', async () => {
    binding.agent.path = 'agent/agent.ts'
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('regular directory')
    await expectUnbound()
  })

  it('rejects oversized ignore files before creating metadata', async () => {
    await writeFile(join(directory, '.gitignore'), 'x'.repeat(1024 * 1024 + 1))
    await expect(bindWorkspace(directory, binding)).rejects.toThrow('1048576 bytes')
    expect(await readdir(directory)).toEqual(['.gitignore', 'agent'])
  })
})
