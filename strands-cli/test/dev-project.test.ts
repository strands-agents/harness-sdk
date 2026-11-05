import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isIgnoredDirectory, resolveDevProject } from '../src/dev/project.js'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'strands-dev-project-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(path: string, content = ''): Promise<string> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
  return target
}

describe('resolveDevProject', () => {
  it('loads a root agent through the existing loader', async () => {
    const entrypoint = await file('agent.py')
    expect(resolveDevProject(root)).toEqual({ root, entrypoint, language: 'python' })
  })

  it('honors .strands-entrypoint', async () => {
    const entrypoint = await file(join('src', 'main.ts'))
    await file('.strands-entrypoint', 'src/main.ts')
    expect(resolveDevProject(root)).toEqual({ root, entrypoint, language: 'typescript' })
  })

  it('finds one agent in a direct subfolder and keeps the launch folder as the root', async () => {
    await file(join('refund_desk', '__init__.py'))
    const entrypoint = await file(join('refund_desk', 'agent.py'))
    expect(resolveDevProject(root)).toEqual({ root, entrypoint, language: 'python' })
  })

  it('ignores dependency, build, and hidden folders', async () => {
    await file(join('node_modules', 'agent.js'))
    await file(join('.venv', 'agent.py'))
    await file(join('dist', 'agent.js'))
    const entrypoint = await file(join('src', 'agent.ts'))
    expect(resolveDevProject(root).entrypoint).toBe(entrypoint)
  })

  it('rejects a folder with no agent', () => {
    expect(() => resolveDevProject(root)).toThrow(
      `No agent found in ${root}. Add agent.py or agent.ts, or use --agent <path>.`
    )
  })

  it('lists every match when more than one subfolder has an agent', async () => {
    await file(join('b', 'agent.ts'))
    await file(join('a', 'agent.py'))
    expect(() => resolveDevProject(root)).toThrow(
      `More than one agent found in ${root}: ${join('a', 'agent.py')}, ${join('b', 'agent.ts')}. Use --agent <path> to select one.`
    )
  })

  it('loads an explicit agent path and rejects ZIP archives', async () => {
    const entrypoint = await file(join('bots', 'custom.ts'))
    expect(resolveDevProject(root, entrypoint).entrypoint).toBe(entrypoint)
    expect(() => resolveDevProject(root, join(root, 'agent.zip'))).toThrow(
      'strands dev cannot load a ZIP archive. Use the project folder or its agent source file.'
    )
  })
})

describe('isIgnoredDirectory', () => {
  it.each([
    ['node_modules', true],
    ['.git', true],
    ['.venv', true],
    ['__pycache__', true],
    ['dist', true],
    ['src', false],
    ['refund_desk', false],
  ])('%s is ignored: %s', (name, ignored) => {
    expect(isIgnoredDirectory(name)).toBe(ignored)
  })
})
