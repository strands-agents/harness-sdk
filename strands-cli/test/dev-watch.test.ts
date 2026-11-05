import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChangeBuffer, isSourceFile, watchSources, type SourceWatcher } from '../src/dev/watch.js'

describe('createChangeBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends one sorted, unique change after the burst stops', () => {
    const onChange = vi.fn()
    const buffer = createChangeBuffer({ debounceMs: 200, onChange })
    buffer.add('tools.py')
    vi.advanceTimersByTime(150)
    buffer.add('agent.py')
    buffer.add('tools.py')
    vi.advanceTimersByTime(199)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(['agent.py', 'tools.py'])
  })

  it('drops pending changes on close', () => {
    const onChange = vi.fn()
    const buffer = createChangeBuffer({ debounceMs: 200, onChange })
    buffer.add('agent.py')
    buffer.close()
    vi.advanceTimersByTime(500)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('isSourceFile', () => {
  it.each([
    ['agent.py', true],
    ['instructions.md', true],
    ['pyproject.toml', true],
    ['Agent.TS', true],
    ['.env', false],
    ['agent.py~', false],
    ['notes.log', false],
  ])('%s is a source file: %s', (name, expected) => {
    expect(isSourceFile(name)).toBe(expected)
  })
})

describe('watchSources', () => {
  let root: string
  let watcher: SourceWatcher | undefined
  let changes: string[]
  let warnings: string[]

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'strands-dev-watch-')))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.venv'))
    changes = []
    warnings = []
  })

  afterEach(async () => {
    watcher?.close()
    watcher = undefined
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  function start(maxDirectories?: number): SourceWatcher {
    watcher = watchSources({
      root,
      debounceMs: 20,
      onChange: (paths) => changes.push(...paths),
      onWarning: (message) => warnings.push(message),
      ...(maxDirectories !== undefined ? { maxDirectories } : {}),
    })
    return watcher
  }

  async function live(directory = root): Promise<void> {
    const probe = join(directory, 'probe.ts')
    await vi.waitFor(
      async () => {
        await writeFile(probe, String(Math.random()))
        expect(changes).toContain(relative(root, probe))
      },
      { timeout: 5_000, interval: 100 }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    changes.length = 0
  }

  const settled = { timeout: 5_000 }

  it('watches the project folders but not dependency or hidden folders', () => {
    expect(start().directories()).toBe(2)
  })

  it('reports source saves and skips other files and ignored folders', async () => {
    start()
    await live(join(root, 'src'))
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    await writeFile(join(root, '.venv', 'site.py'), 'x')
    await writeFile(join(root, 'notes.log'), 'x')
    await writeFile(join(root, 'src', 'tools.py'), 'x')
    await vi.waitFor(() => expect(changes).toContain(join('src', 'tools.py')), settled)
    expect(changes.every((path) => path === join('src', 'tools.py'))).toBe(true)
  })

  it('watches folders that occur after start', async () => {
    start()
    await live(join(root, 'src'))
    await mkdir(join(root, 'src', 'new'))
    await vi.waitFor(() => expect(watcher!.directories()).toBe(3), settled)
    await live(join(root, 'src', 'new'))
    await writeFile(join(root, 'src', 'new', 'helper.ts'), 'x')
    await vi.waitFor(() => expect(changes).toContain(join('src', 'new', 'helper.ts')), settled)
  })

  it('reports a deleted source file', async () => {
    await writeFile(join(root, 'agent.py'), 'x')
    start()
    await live()
    await rm(join(root, 'agent.py'))
    await vi.waitFor(() => expect(changes).toContain('agent.py'), settled)
  })

  it('stops the watch on a removed folder', async () => {
    await mkdir(join(root, 'src', 'old'))
    start()
    expect(watcher!.directories()).toBe(3)
    await live(join(root, 'src'))
    await rm(join(root, 'src', 'old'), { recursive: true, force: true, maxRetries: 3 })
    await vi.waitFor(() => expect(watcher!.directories()).toBe(2), settled)
  })

  it('reports a folder that appears with files in it', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'strands-dev-moved-')))
    try {
      await writeFile(join(outside, 'tools.py'), 'x')
      start()
      await live(join(root, 'src'))
      await rename(outside, join(root, 'src', 'tools'))
      await vi.waitFor(() => expect(changes).toContain(join('src', 'tools')), settled)
      expect(watcher!.directories()).toBe(3)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips virtual environments whatever their name', async () => {
    await mkdir(join(root, 'env', 'lib'), { recursive: true })
    await writeFile(join(root, 'env', 'pyvenv.cfg'), 'home = /usr/bin')
    expect(start().directories()).toBe(2)
  })

  it('stops the watch on a folder that becomes a virtual environment', async () => {
    start()
    await live(join(root, 'src'))
    await mkdir(join(root, 'src', 'env', 'lib'), { recursive: true })
    await vi.waitFor(() => expect(watcher!.directories()).toBe(4), settled)
    await writeFile(join(root, 'src', 'env', 'pyvenv.cfg'), 'home = /usr/bin')
    await vi.waitFor(() => expect(watcher!.directories()).toBe(2), settled)
  })

  it('watches shallow folders first when the folder limit applies', async () => {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true })
    await mkdir(join(root, 'z'))
    start(4)
    await live(join(root, 'z'))
    expect(warnings).toHaveLength(1)
  })

  it('warns once when the folder limit stops the watch', async () => {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    expect(start(2).directories()).toBe(2)
    expect(warnings).toEqual(['Watching the first 2 folders only. Changes in other folders do not reload the agent.'])
  })
})
