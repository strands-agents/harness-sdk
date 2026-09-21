import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import TextCache from '#ink-text-cache'

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const inkBuild = dirname(fileURLToPath(import.meta.resolve('ink')))
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await setWritable(directory, true)
    await rm(directory, { recursive: true, force: true })
  }
})

describe('bounded text cache', () => {
  it('bounds both entry count and retained text, including wrapped values', () => {
    const cache = new TextCache()
    cache.set('sentinel', 'value')
    for (let index = 0; index < 1_000; index++) {
      cache.set('overwrite', 'x'.repeat(6_000))
    }
    expect(cache.get('sentinel')).toBe('value')
    for (let index = 0; index < 1_000; index++) {
      cache.set(`revision-${index}`, 'value')
    }
    expect(cache.get('sentinel')).toBeUndefined()
    expect(cache.get('revision-999')).toBe('value')

    cache.set('large', 'x'.repeat(600_000))
    cache.set('other', 'y'.repeat(600_000))
    expect(cache.get('large')).toBeUndefined()
    expect(cache.get('other')).toHaveLength(600_000)

    const oversized = 'z'.repeat(1_048_577)
    cache.set(oversized, 'value')
    cache.set('oversized', oversized)
    expect(cache.get(oversized)).toBeUndefined()
    expect(cache.get('oversized')).toBeUndefined()
  })
})

describe('installed Ink cache protection', () => {
  it.each([
    { writable: true, legacy: false },
    { writable: false, legacy: false },
    { writable: false, legacy: true },
  ])('launches without modifying the installation: %o', async ({ writable, legacy }) => {
    const directory = await installedFixture(legacy)
    const watched = [
      'node_modules/ink/build/measure-text.js',
      'node_modules/ink/build/wrap-text.js',
      'dist/src/tui/terminal/ink.js',
    ]
    const before = await Promise.all(watched.map((path) => readFile(join(directory, path), 'utf8')))
    await setWritable(directory, writable)
    for (const entrypoint of ['bin/strands.js', 'dist/src/main.js']) {
      const { stdout, stderr } = await execute(process.execPath, [join(directory, entrypoint)], {
        cwd: directory,
      })
      expect(stdout).toBe('bounded Ink cache active\n')
      expect(stderr).toBe('')
    }
    expect(await Promise.all(watched.map((path) => readFile(join(directory, path), 'utf8')))).toEqual(before)
    expect((await readdir(join(directory, 'node_modules/ink/build'))).sort()).toEqual(
      ['index.js', 'measure-text.js', 'wrap-text.js', ...(legacy ? ['strands-text-cache.js'] : [])].sort()
    )
  })
})

async function installedFixture(legacy: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strands-ink-cache-'))
  temporaryDirectories.push(directory)
  const build = join(directory, 'node_modules/ink/build')
  await Promise.all([
    mkdir(build, { recursive: true }),
    mkdir(join(directory, 'bin')),
    mkdir(join(directory, 'dist/src/tui/terminal'), { recursive: true }),
  ])
  await copyFile(join(packageRoot, 'package.json'), join(directory, 'package.json'))
  await copyFile(join(inkBuild, '../package.json'), join(build, '../package.json'))
  await copyFile(join(inkBuild, 'index.js'), join(build, 'index.js'))
  await copyFile(join(packageRoot, 'test/fixtures/ink-cache-probe.mjs'), join(directory, 'dist/src/main.js'))
  for (const path of ['bin/strands.js', 'dist/src/tui/terminal/ink.js']) {
    await copyFile(join(packageRoot, path), join(directory, path))
  }
  for (const name of ['widest-line', 'wrap-ansi', 'cli-truncate']) {
    await symlink(join(packageRoot, '../node_modules', name), join(directory, 'node_modules', name), 'junction')
  }
  for (const name of ['measure-text.js', 'wrap-text.js']) {
    let source = await readFile(join(inkBuild, name), 'utf8')
    if (!legacy) {
      source = source
        .replace("import TextCache from './strands-text-cache.js';\n", '')
        .replace(
          'const cache = new TextCache();',
          name === 'measure-text.js' ? 'const cache = new Map();' : 'const cache = {};'
        )
        .replace('cache.get(cacheKey);', 'cache[cacheKey];')
        .replace('cache.set(cacheKey, wrappedText);', 'cache[cacheKey] = wrappedText;')
    } else if (!source.startsWith("import TextCache from './strands-text-cache.js';")) {
      source =
        "import TextCache from './strands-text-cache.js';\n" +
        source
          .replace('const cache = new Map();', 'const cache = new TextCache();')
          .replace('const cache = {};', 'const cache = new TextCache();')
          .replace('cache[cacheKey];', 'cache.get(cacheKey);')
          .replace('cache[cacheKey] = wrappedText;', 'cache.set(cacheKey, wrappedText);')
    }
    await writeFile(join(build, name), source)
  }
  if (legacy) {
    await writeFile(
      join(build, 'strands-text-cache.js'),
      "throw new Error('Use the packaged cache, not the legacy copy')\n"
    )
  }
  return directory
}

async function setWritable(directory: string, writable: boolean): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await setWritable(path, writable)
    } else if (entry.isFile()) {
      await chmod(path, writable ? 0o644 : 0o444)
    }
  }
  await chmod(directory, writable ? 0o755 : 0o555)
}
