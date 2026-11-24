import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PythonBackend } from '../../src/project/python.js'
import { CliConfigStore } from '../../src/config/store.js'
import { pythonEnvironment, pythonExecutable } from '../fixtures/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const backends: PythonBackend[] = []
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
  vi.unstubAllEnvs()
})

describe.skipIf(!existsSync(pythonExecutable))('Python installed package loading', () => {
  it('shouldImportTheRealPackageWhenAnInstalledEntrypointUsesSrcLayout', async () => {
    const root = await temporaryDirectory()
    const sourceRoot = join(root, 'src')
    const packageRoot = join(sourceRoot, 'refund_desk')
    await mkdir(packageRoot, { recursive: true })
    await symlink(pythonEnvironment, join(root, '.venv'), 'junction')
    await writeFile(join(packageRoot, '__init__.py'), '')
    await writeFile(join(packageRoot, 'tools.py'), 'NAME = "Refund desk package"\n')
    await copyFile(new URL('../fixtures/source-reload-model.py', import.meta.url), join(packageRoot, 'model.py'))
    const source = `from strands_harness import create_harness
from refund_desk.tools import NAME
from .model import SourceReloadModel
agent = create_harness(name=NAME, model=SourceReloadModel(), memory=False, session=False, skills=False, builtin_tools=[], builtin_plugins=[], context_manager=False, background_tasks=False)
`
    const entrypoint = join(packageRoot, 'agent.py')
    await writeFile(entrypoint, source)
    vi.stubEnv('PYTHONPATH', sourceRoot)
    vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')

    const backend = await PythonBackend.open(
      { root, entrypoint, language: 'python' },
      CliConfigStore.memory(),
      { cwd: root, devWorkspace: root, prepared: true },
      AbortSignal.timeout(20000)
    )
    backends.push(backend)

    expect(backend.name).toBe('Refund desk package')
    expect(await readFile(entrypoint, 'utf8')).toBe(source)
  }, 25000)
})
