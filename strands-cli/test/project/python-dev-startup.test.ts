import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { PythonBackend } from '../../src/project/python.js'
import * as runtime from '../../src/project/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(() => {
    throw new Error('Worker spawn reached')
  }),
}))

afterEach(() => vi.restoreAllMocks())

describe('discovered Python dev startup', () => {
  it('shouldPrepareTheRuntimeBeforeStartingTheWorkerWhenOpeningADevProject', async () => {
    const root = await temporaryDirectory()
    const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const preparation = vi.spyOn(runtime, 'preparePythonRuntime').mockImplementation(async () => {
      await mkdir(dirname(python), { recursive: true })
      await writeFile(python, 'fixture')
      return python
    })
    const signal = new AbortController().signal

    await expect(
      PythonBackend.open(
        { root, entrypoint: join(root, 'agent.py'), language: 'python' },
        CliConfigStore.memory(),
        { devWorkspace: root },
        signal
      )
    ).rejects.toThrow('Worker spawn reached')

    expect(preparation).toHaveBeenCalledExactlyOnceWith(root, { signal })
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[0]).toBe(python)
    expect(preparation.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawn).mock.invocationCallOrder.at(-1)!)
  })

  it('shouldNotRunTheWorkerWhenEnvironmentPreparationFails', async () => {
    const root = await temporaryDirectory()
    vi.spyOn(runtime, 'preparePythonRuntime').mockRejectedValue(new Error('Python setup failed'))
    vi.mocked(spawn).mockClear()

    await expect(
      PythonBackend.open({ root, entrypoint: join(root, 'agent.py'), language: 'python' }, CliConfigStore.memory(), {
        devWorkspace: root,
      })
    ).rejects.toThrow('Python setup failed')

    expect(spawn).not.toHaveBeenCalled()
  })

  it('shouldLeavePlainAgentLaunchUnchangedWhenDevIsNotSelected', async () => {
    const root = await temporaryDirectory()
    const preparation = vi.spyOn(runtime, 'preparePythonRuntime')

    await expect(
      PythonBackend.open({ root, entrypoint: join(root, 'agent.py'), language: 'python' }, CliConfigStore.memory())
    ).rejects.toThrow('Worker spawn reached')

    expect(preparation).not.toHaveBeenCalled()
  })
})
