import { watch, type FSWatcher } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

import { watchAgentProject } from '../../src/project/watch.js'

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
    notify('change', 'config.json')
    vi.advanceTimersByTime(250)
    expect(changed).toHaveBeenLastCalledWith(['config.json'])
  } finally {
    stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})
