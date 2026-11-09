import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'
import { PythonBackend } from '../src/tui/project/python.js'
import { pythonEnvironment, pythonExecutable as python } from './fixtures/python-runtime.js'

describe.skipIf(!existsSync(python))('Python source reloads', () => {
  let root: string
  let entrypoint: string
  const backends: PythonBackend[] = []

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'strands-python-source-reload-')))
    await symlink(pythonEnvironment, join(root, '.venv'), 'junction')
    await mkdir(join(root, 'agent'))
    await writeFile(join(root, 'agent', '__init__.py'), 'package_marker = "PACKAGE_INIT"\n')
    await copyFile(
      new URL('./fixtures/source-reload-model.py', import.meta.url),
      join(root, 'agent', 'source_reload_model.py')
    )
    await writeFile(join(root, 'agent', 'helper.py'), 'version = "v1"\n')
    entrypoint = join(root, 'agent', 'definition.py')
    await writeFile(
      entrypoint,
      `from strands import tool
from strands_harness import create_harness
from . import package_marker
from .helper import version
from .source_reload_model import SourceReloadModel

@tool
def source_version() -> str:
    """Return the authored helper version."""
    return version

agent = create_harness(
    name=package_marker, description=version, model=SourceReloadModel(), effort="off",
    caching=False, builtin_tools=[], builtin_plugins=[], tools=[source_version],
    memory=False, session=False, skills=False, context_manager=False, background_tasks=False,
)
`
    )
    vi.stubEnv('PYTHONPATH', fileURLToPath(new URL('../../harness-py/src', import.meta.url)))
    vi.stubEnv('PYTHONPYCACHEPREFIX', join(root, 'bytecode'))
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  })

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  async function open(interactive = false): Promise<PythonBackend> {
    const backend = await PythonBackend.open(
      { root, entrypoint, language: 'python' },
      CliConfigStore.memory(),
      { cwd: root, interactive },
      AbortSignal.timeout(15_000)
    )
    backends.push(backend)
    return backend
  }

  it('uses normal package initialization and does not inject CLI tools outside the TUI', async () => {
    const authored = await readFile(entrypoint)
    const backend = await open()

    expect(backend.name).toBe('PACKAGE_INIT')
    expect(backend.info().description).toBe('v1')
    expect(backend.info().tools?.map((tool) => tool.name)).toEqual(['source_version'])
    expect(backend.reconstructable()).toBe(true)
    expect(await readFile(entrypoint)).toEqual(authored)
  }, 15_000)

  it('reloads project source even when timestamp and file size are unchanged', async () => {
    const first = await open()
    const helper = join(root, 'agent', 'helper.py')
    const before = await stat(helper)

    await writeFile(helper, 'version = "v2"\n')
    await utimes(helper, before.atime, before.mtime)
    const second = await open()

    expect(first.info().description).toBe('v1')
    expect(second.info().description).toBe('v2')
  }, 15_000)

  it('surfaces a source reload request after strands_config apply', async () => {
    const backend = await open(true)

    for await (const _event of backend.stream(
      JSON.stringify({ tool: 'strands_config', input: { action: 'apply', revision: 0 } })
    )) {
      // Drain the deterministic tool turn.
    }

    expect(backend.takeReloadRequest()).toMatchObject({ agentProject: entrypoint })
    expect(backend.takeReloadRequest()).toBeUndefined()
  }, 15_000)
})
