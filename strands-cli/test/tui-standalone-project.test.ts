import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { exportSourceProject } from '../src/tui/project/export.js'
import { importAgentProject } from '../src/tui/project/import.js'

let root: string

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'strands-standalone-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(path: string, contents: string | Uint8Array = ''): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

it.each(['ts', 'mts', 'js', 'mjs', 'py'])('accepts a directly selected independent .%s module', async (extension) => {
  const entrypoint = join(root, `custom.${extension}`)
  await file(entrypoint)
  expect(importAgentProject(entrypoint)).toEqual({
    root,
    entrypoint,
    language: extension === 'py' ? 'python' : 'typescript',
  })
})

it('honors a safe marker and rejects a marker escaping through an ancestor', async () => {
  await file(join(root, 'src/custom.py'), 'agent = None\r\n')
  await file(join(root, '.strands-entrypoint'), '\uFEFF./src/custom.py\r\n')
  expect(importAgentProject(root).entrypoint).toBe(join(root, 'src/custom.py'))

  await file(join(root, '.strands-entrypoint'), '../outside.py')
  expect(() => importAgentProject(root)).toThrow('Invalid .strands-entrypoint')
})

it('preserves authored bytes and selects an arbitrary source through repeated ZIP export', async () => {
  const source = join(root, 'source')
  const authored = {
    'src/custom.mjs': Buffer.from('\uFEFF// Grüße 🐸\r\nexport const agent = {}\r\n'),
    'assets/data.bin': Buffer.from([0, 255, 128, 13, 10]),
    'package.json': Buffer.from('{"private":true,"type":"module"}\r\n'),
    '.env.example': Buffer.from('EXAMPLE_TOKEN=\r\n'),
  }
  for (const [name, contents] of Object.entries(authored)) await file(join(source, name), contents)
  await file(join(source, '.env'), 'PRIVATE')
  await file(join(source, '.agent/sessions/session.json'), 'PRIVATE')

  let project = importAgentProject(join(source, 'src/custom.mjs'))
  for (let round = 0; round < 2; round += 1) {
    const archive = join(root, `round-${round}.zip`)
    await exportSourceProject(project, 'Authored', 'typescript', [], archive)
    const entries = unzipSync(await readFile(archive))
    for (const [name, contents] of Object.entries(authored)) {
      expect(Buffer.from(entries[name]!)).toEqual(contents)
    }
    expect(entries).not.toHaveProperty('.env')
    expect(entries).not.toHaveProperty('.agent/sessions/session.json')
    expect(Buffer.from(entries['.strands-entrypoint']!).toString()).toBe('src/custom.mjs\n')
    project = importAgentProject(archive)
  }
})

it('does not discard a ZIP manifest and assets to find an unmarked nested module', async () => {
  const archive = join(root, 'project.zip')
  await file(
    archive,
    zipSync({
      'wrapper/package.json': Buffer.from('{}'),
      'wrapper/src/agent.ts': Buffer.from('authored'),
      'wrapper/data.bin': Buffer.from([0, 255]),
    })
  )
  expect(() => importAgentProject(archive)).toThrow('Unzip it and choose the source file')
})
