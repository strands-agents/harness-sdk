import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatEvent } from '../src/tui/chat/types.js'
import { CliConfigStore } from '../src/tui/config.js'
import { PythonBackend, type PythonOptions } from '../src/tui/project/python.js'
import { pythonExecutable as python } from './fixtures/python-runtime.js'

const baseSource = `from strands import tool
from strands_harness import create_harness
from source_reload_model import SourceReloadModel

@tool
def status() -> str:
    """Return a value from the authored tool."""
    return "authored tool"

def build(**overrides):
    options = {
        "model": SourceReloadModel(), "effort": "off", "caching": False,
        "builtin_tools": [], "builtin_plugins": [], "tools": [status],
        "memory": False, "session": False, "skills": False,
        "context_manager": False, "background_tasks": False,
    }
    options.update(overrides)
    return create_harness(**options)

agent = build()
`

describe.skipIf(!existsSync(python))('Python source loading', () => {
  let root: string
  const backends: PythonBackend[] = []

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'strands-python-options-')))
    await symlink(dirname(dirname(python)), join(root, '.venv'), 'junction')
    await copyFile(new URL('./fixtures/source-reload-model.py', import.meta.url), join(root, 'source_reload_model.py'))
    vi.stubEnv('PYTHONPATH', fileURLToPath(new URL('../../harness-py/src', import.meta.url)))
    vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  })

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  async function open(authored: string | Uint8Array, options: PythonOptions = {}): Promise<PythonBackend> {
    const entrypoint = join(root, 'agent.py')
    await writeFile(entrypoint, authored)
    const backend = await PythonBackend.open(
      { root, entrypoint, language: 'python' },
      CliConfigStore.memory(),
      { cwd: root, ...options },
      AbortSignal.timeout(15_000)
    )
    backends.push(backend)
    return backend
  }

  async function turn(backend: PythonBackend): Promise<ChatEvent[]> {
    const events: ChatEvent[] = []
    for await (const event of backend.stream(JSON.stringify({ tool: 'status' }))) {
      events.push(event)
    }
    return events
  }

  it('runs an arbitrary exported instance unchanged and disables reconstruction', async () => {
    const authored = `${baseSource}
agent.name = "Customized"
`
    const backend = await open(authored)

    expect(backend.name).toBe('Customized')
    expect(backend.reconstructable()).toBe(false)
    expect(await turn(backend)).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        status: 'success',
        content: [{ type: 'text', text: 'authored tool' }],
      })
    )
    await expect(backend.clear()).rejects.toThrow('create_agent(**overrides)')
    expect(await readFile(join(root, 'agent.py'), 'utf8')).toBe(authored)
  })

  it('routes arbitrary-instance tool calls through the CLI permission broker', async () => {
    const backend = await open(baseSource, { interactive: true })
    const requests: string[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (!request) return
      requests.push(request.toolName)
      backend.respondPermission(request.id, 'deny')
    })
    try {
      const events = await turn(backend)
      expect(requests).toEqual(['status'])
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'toolResult', status: 'success' }))
    } finally {
      unwatch()
    }
  })

  it('adds CLI-discovered skills and MCP servers to arbitrary instances', async () => {
    const skillDirectory = join(root, 'discovered-skill')
    await writeFile(join(root, 'mcp-marker.txt'), 'ready')
    await mkdir(skillDirectory)
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: discovered-skill\ndescription: Discovered skill\n---\nUse the discovered skill.\n'
    )
    const backend = await open(baseSource, {
      skillPaths: [skillDirectory],
      mcpServers: {
        external: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/self-building-mcp.mjs', import.meta.url))],
          cwd: root,
        },
      },
    })

    expect(backend.skills.map((skill) => skill.name)).toContain('discovered-skill')
    expect(backend.info().tools?.map((tool) => tool.name)).toContain('external_probe')
  })

  it('uses create_agent for explicit CLI reconstruction controls', async () => {
    const authored = baseSource.replace(
      'agent = build()',
      'def create_agent(**overrides):\n    return build(**overrides)\n\nagent = create_agent()'
    )
    const backend = await open(authored, {
      overrides: { name: 'Overridden', session: false },
    })

    expect(backend.name).toBe('Overridden')
    expect(backend.reconstructable()).toBe(true)
    await backend.clear()
    expect(backend.name).toBe('Overridden')
  })

  it('reconstructs generated direct create_harness source without requiring a redundant factory', async () => {
    const authored = baseSource
      .replace('def build(**overrides):', 'def build_options():')
      .replace('    options.update(overrides)\n    return create_harness(**options)', '    return options')
      .replace('agent = build()', 'agent = create_harness(**build_options())')
    const backend = await open(authored, { overrides: { name: 'Generated', session: false } })

    expect(backend.name).toBe('Generated')
    expect(backend.reconstructable()).toBe(true)
    await backend.clear()
    expect(backend.name).toBe('Generated')
  })

  it.each(['bom-crlf', 'latin1-cookie'])('loads non-ASCII %s source without changing its bytes', async (encoding) => {
    const text = `${baseSource}\nagent.name = "café"\n`
    const authored =
      encoding === 'bom-crlf'
        ? Buffer.from(`\uFEFF${text.replaceAll('\n', '\r\n')}`)
        : Buffer.from(`# coding: latin-1\n${text}`, 'latin1')
    const backend = await open(authored)

    expect(backend.name).toBe('café')
    expect(await readFile(join(root, 'agent.py'))).toEqual(authored)
  })
})
