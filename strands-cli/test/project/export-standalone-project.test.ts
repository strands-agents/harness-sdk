import { realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { exportSourceProject } from '../../src/project/export.js'
import { importAgentProject } from '../../src/project/import.js'
import { MAX_PROJECT_BYTES } from '../../src/project/packaging.js'

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

it(
  'rejects exports exceeding the import entry limit, including directories and the generated marker',
  { timeout: 30_000 },
  async () => {
    const source = join(root, 'source')
    await file(join(source, 'agent.ts'), 'export const agent = {}')
    await mkdir(join(source, 'empty'))
    for (let index = 0; index < 9_998; index++) {
      writeFileSync(join(source, `${index}.txt`), '')
    }
    const project = importAgentProject(source)
    for (const output of ['zip', 'directory'] as const) {
      const destination = join(root, output === 'zip' ? 'agent.zip' : 'agent-directory')
      await expect(exportSourceProject(project, 'Agent', 'typescript', [], destination, output)).rejects.toThrow(
        'exceeds 10,000 entries'
      )
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }
)

it('names oversized source files without writing an archive', async () => {
  const source = join(root, 'source')
  await file(join(source, 'agent.py'))
  const oversized = join(source, 'large.bin')
  await file(oversized)
  await truncate(oversized, MAX_PROJECT_BYTES + 1)
  const destination = join(root, 'agent.zip')

  await expect(exportSourceProject(importAgentProject(source), 'Agent', 'python', [], destination)).rejects.toThrow(
    `exceeds 50 MB while adding ${oversized}`
  )
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['src/custom.mjs', ' leading.mjs', ' leading/custom.mjs'])(
  'preserves authored bytes and entrypoint %s through ZIP and directory export',
  async (entrypoint) => {
    const source = join(root, 'source')
    const authored = {
      [entrypoint]: Buffer.from('\uFEFF// Grüße 🐸\r\nexport const agent = {}\r\n'),
      'assets/data.bin': Buffer.from([0, 255, 128, 13, 10]),
      'package.json': Buffer.from('{"private":true,"type":"module"}\r\n'),
      '.env.example': Buffer.from('EXAMPLE_TOKEN=\r\n'),
      ['__proto__']: Buffer.from('An ordinary authored file\r\n'),
    }
    for (const [name, contents] of Object.entries(authored)) await file(join(source, name), contents)
    await file(join(source, '.env'), 'PRIVATE')
    await file(join(source, '.agent/sessions/session.json'), 'PRIVATE')

    let project = importAgentProject(join(source, entrypoint))
    for (let round = 0; round < 2; round += 1) {
      const archive = join(root, `round-${round}.zip`)
      await exportSourceProject(project, 'Authored', 'typescript', [], archive)
      const entries = unzipSync(await readFile(archive))
      project = importAgentProject(archive)
      expect(project.entrypoint).toBe(join(project.root, entrypoint))
      for (const [name, contents] of Object.entries(authored)) {
        expect(await readFile(join(project.root, name))).toEqual(contents)
      }
      expect(entries).not.toHaveProperty('.env')
      expect(entries).not.toHaveProperty('.agent/sessions/session.json')
      expect(Buffer.from(entries['.strands-entrypoint']!).toString()).toBe(`./${entrypoint}\n`)
    }

    const directory = join(root, 'authored-folder')
    await exportSourceProject(project, 'Authored', 'typescript', [], directory, 'directory')
    for (const [name, contents] of Object.entries(authored)) {
      expect(await readFile(join(directory, name))).toEqual(contents)
    }
    expect(await readFile(join(directory, '.strands-entrypoint'), 'utf8')).toBe(`./${entrypoint}\n`)
    expect(importAgentProject(directory).entrypoint).toBe(join(directory, entrypoint))
  }
)

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
