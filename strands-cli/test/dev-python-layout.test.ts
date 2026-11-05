import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveDevProject } from '../src/dev/project.js'
import { CliConfigStore } from '../src/tui/config.js'
import { PythonBackend } from '../src/tui/project/python.js'
import { pythonEnvironment, pythonExecutable as python } from './fixtures/python-runtime.js'

describe.skipIf(!existsSync(python))('strands dev Python package layout', () => {
  let root: string
  let backend: PythonBackend | undefined

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'strands-dev-python-')))
    await symlink(pythonEnvironment, join(root, '.venv'), 'junction')
    await mkdir(join(root, 'refund_desk'))
    await writeFile(join(root, 'refund_desk', '__init__.py'), '')
    await writeFile(join(root, 'refund_desk', 'tools.py'), 'version = "v1"\n')
    await copyFile(
      new URL('./fixtures/source-reload-model.py', import.meta.url),
      join(root, 'refund_desk', 'source_reload_model.py')
    )
    await writeFile(
      join(root, 'refund_desk', 'agent.py'),
      `from strands_harness import create_harness
from refund_desk.tools import version
from refund_desk.source_reload_model import SourceReloadModel

agent = create_harness(
    name="refund-desk", description=version, model=SourceReloadModel(), effort="off",
    caching=False, builtin_tools=[], builtin_plugins=[], tools=[],
    memory=False, session=False, skills=False, context_manager=False, background_tasks=False,
)
`
    )
    vi.stubEnv('PYTHONPATH', fileURLToPath(new URL('../../harness-py/src', import.meta.url)))
    vi.stubEnv('PYTHONPYCACHEPREFIX', join(root, 'bytecode'))
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  })

  afterEach(async () => {
    await backend?.dispose()
    backend = undefined
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('imports the agent package from the launch folder', async () => {
    const project = resolveDevProject(root)
    backend = await PythonBackend.open(project, CliConfigStore.memory(), { cwd: root }, AbortSignal.timeout(15_000))

    expect(project.root).toBe(root)
    expect(backend.name).toBe('refund-desk')
    expect(backend.info().description).toBe('v1')
  }, 20_000)
})
