import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { PythonBackend } from '../../src/project/python.js'
import { pythonEnvironment, pythonExecutable } from '../fixtures/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const active: PythonBackend[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((backend) => backend.dispose()))
  vi.unstubAllEnvs()
})

const fixture = async (state: boolean): Promise<{ root: string; source: string }> => {
  const root = await temporaryDirectory()
  await symlink(pythonEnvironment, join(root, '.venv'), 'junction')
  await mkdir(join(root, 'private'))
  await writeFile(join(root, 'private', 'keep.txt'), 'original state')
  await copyFile(new URL('../fixtures/source-reload-model.py', import.meta.url), join(root, 'source_reload_model.py'))
  const source = `from strands_harness import create_harness
from source_reload_model import SourceReloadModel
agent = create_harness(name="Workspace Python", model=SourceReloadModel(), builtin_tools=[], builtin_plugins=[], skills=False, memory=False, session=${state ? '{"dir": "private"}' : 'False'}, context_manager=False, background_tasks=False)
`
  await writeFile(join(root, 'agent.py'), source)
  return { root, source }
}

describe.skipIf(!existsSync(pythonExecutable))('Python dev isolation', () => {
  it.each([true, false])(
    'shouldKeepStateInTheWorkspaceWhenSessionsAre%s',
    async (state) => {
      const { root, source } = await fixture(state)
      vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
      vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')

      const backend = await PythonBackend.open(
        { root, entrypoint: join(root, 'agent.py'), language: 'python' },
        CliConfigStore.memory(),
        { cwd: root, devWorkspace: root },
        AbortSignal.timeout(20_000)
      )
      active.push(backend)

      expect(backend.name).toBe('Workspace Python')
      expect(backend.info().tools ?? []).toEqual([])
      if (state) expect(backend.sessionDirectory).toContain(join(root, '.strands', 'state', 'sessions'))
      else expect(backend.sessionIdentity).toBeUndefined()
      expect(await readFile(join(root, 'agent.py'), 'utf8')).toBe(source)
      expect(await readFile(join(root, 'private', 'keep.txt'), 'utf8')).toBe('original state')
    },
    25_000
  )
})
