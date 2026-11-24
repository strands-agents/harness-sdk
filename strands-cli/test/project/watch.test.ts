import { watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { isAgentSourceFile, watchAgentProject } from '../../src/project/watch.js'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: vi.fn(),
}))

it('ignores custom session and memory paths while reloading neighboring source files', () => {
  vi.useFakeTimers()
  const watcher = { on: vi.fn(), close: vi.fn() }
  vi.mocked(watch).mockReturnValue(watcher as unknown as FSWatcher)
  const root = resolve('project')
  const changed = vi.fn()
  const failed = vi.fn()
  const stop = watchAgentProject(
    { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' },
    changed,
    failed,
    ['state/sessions', join(root, 'state', 'memory')]
  )
  try {
    const notify = vi.mocked(watch).mock.calls[0]!.at(-1) as (event: string, filename: string) => void
    notify('change', join('state', 'sessions', 'snapshot.json'))
    notify('change', join('state', 'memory', 'record.json'))
    notify('change', join('.strands', 'state', 'sessions', 'snapshot.json'))
    notify('change', join('.strands', 'reports', 'report.json'))
    vi.advanceTimersByTime(250)
    expect(changed).not.toHaveBeenCalled()

    notify('change', join('state', 'sessions-helper.ts'))
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenCalledExactlyOnceWith([join('state', 'sessions-helper.ts')])
    expect(failed).not.toHaveBeenCalled()
  } finally {
    stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

it('shouldCollectUniqueChangedFilesWhenSavesShareTheDebounceWindow', () => {
  vi.useFakeTimers()
  const watcher = { on: vi.fn(), close: vi.fn() }
  vi.mocked(watch).mockReturnValue(watcher as unknown as FSWatcher)
  const changed = vi.fn()
  const root = resolve('project')
  const stop = watchAgentProject({ root, entrypoint: join(root, 'agent.ts'), language: 'typescript' }, changed, vi.fn())
  try {
    const notify = vi.mocked(watch).mock.calls.at(-1)!.at(-1) as (event: string, filename: string) => void
    notify('change', 'tools.ts')
    notify('change', 'agent.ts')
    notify('change', 'agent.ts')
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenCalledExactlyOnceWith(['agent.ts', 'tools.ts'])
    notify('change', 'package.json')
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenLastCalledWith(['package.json'])
  } finally {
    stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

it('shouldNotReloadWhenTheAgentWritesLogsDataOrOutputInItsFolder', () => {
  vi.useFakeTimers()
  const watcher = { on: vi.fn(), close: vi.fn() }
  vi.mocked(watch).mockReturnValue(watcher as unknown as FSWatcher)
  const changed = vi.fn()
  const root = resolve('project')
  const stop = watchAgentProject({ root, entrypoint: join(root, 'agent.ts'), language: 'typescript' }, changed, vi.fn())
  try {
    const notify = vi.mocked(watch).mock.calls.at(-1)!.at(-1) as (event: string, filename: string) => void
    notify('change', 'agent.log')
    notify('change', join('logs', 'run.jsonl'))
    notify('change', join('data', 'results.json'))
    vi.advanceTimersByTime(250)

    expect(changed).not.toHaveBeenCalled()

    notify('change', 'agent.ts')
    vi.advanceTimersByTime(250)

    expect(changed).toHaveBeenCalledExactlyOnceWith(['agent.ts'])
  } finally {
    stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

describe('isAgentSourceFile', () => {
  it.each([
    'agent.ts',
    join('agent', 'tools', 'search.mjs'),
    'agent.py',
    join('src', 'refund_desk', '__init__.py'),
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'pyproject.toml',
    'requirements.txt',
    'uv.lock',
    join('skills', 'review', 'SKILL.md'),
    join('skills', 'review', 'scripts', 'check.sh'),
    join('.agent', 'skills', 'review', 'SKILL.md'),
    join('tools', 'research', 'skill.md'),
    'mcp.json',
    '.mcp.json',
    join('.kiro', 'settings', 'mcp.json'),
    join('policies', 'deny.cedar'),
    'AGENTS.md',
    'instructions.md',
    join('prompts', 'system.txt'),
    'config.yaml',
  ])('shouldReloadWhenTheChangedFileIs %s', (path) => {
    expect(isAgentSourceFile(path)).toBe(true)
  })

  it.each([
    'agent.log',
    join('logs', 'run.jsonl'),
    'results.json',
    join('data', 'table.csv'),
    'cache.sqlite',
    join('.agent', 'sessions', 'one', 'snapshot_latest.json'),
    join('.agent', 'memory', 'facts.md'),
    join('.strands', 'state', 'sessions', 'snapshot.json'),
    join('node_modules', 'left-pad', 'index.js'),
    join('__pycache__', 'agent.cpython-312.pyc'),
    join('dist', 'agent.js'),
    join('.git', 'index'),
  ])('shouldNotReloadWhenTheChangedFileIs %s', (path) => {
    expect(isAgentSourceFile(path)).toBe(false)
  })
})
