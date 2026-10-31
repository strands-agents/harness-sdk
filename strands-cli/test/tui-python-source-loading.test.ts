import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'

import type { ChatEvent, ChatRunResult } from '../src/tui/chat/types.js'
import { CliConfigStore } from '../src/tui/config.js'
import { PythonBackend, type PythonOptions } from '../src/tui/project/python.js'
import { exportSourceProject } from '../src/tui/project/export.js'
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

  async function runTurn(backend: PythonBackend): Promise<ChatRunResult> {
    const stream = backend.stream(JSON.stringify({ tool: 'status' }))
    let next = await stream.next()
    while (!next.done) {
      next = await stream.next()
    }
    return next.value
  }

  it.each([
    '{"dir": "custom-memory"}',
    'MemoryManager(stores=[FileMemoryStore(name="private", storage=LocalFileStorage("custom-memory").namespace(""), writable=False)], injection=False)',
  ])('excludes actual memory storage from exports: %s', async (memory) => {
    const privateDirectory = join(root, 'custom-memory')
    await mkdir(privateDirectory, { recursive: true })
    const privateFile = join(privateDirectory, 'personal-notes.md')
    await writeFile(privateFile, 'PRIVATE MEMORY SENTINEL')
    await writeFile(join(root, 'custom-memory-public.md'), 'public source')
    const backend = await open(
      `from strands.memory import MemoryManager
from strands.storage import LocalFileStorage
from strands.vended_memory_stores.file_memory_store import FileMemoryStore
${baseSource.replace('"memory": False', `"memory": ${memory}`)}`
    )
    expect(backend.privatePaths).toContain(privateDirectory)

    const project = { root, entrypoint: join(root, 'agent.py'), language: 'python' as const }
    const archive = join(root, '.agent', 'export.zip')
    await exportSourceProject(project, 'Private memory', 'python', backend.privatePaths, archive)
    const files = unzipSync(await readFile(archive))
    expect(files).not.toHaveProperty('custom-memory/personal-notes.md')
    expect(files).toHaveProperty('custom-memory-public.md')
  })

  it.each([false, true])(
    'excludes context stash storage from exports with a custom namespace=%s',
    async (namespaced) => {
      await writeFile(join(root, 'public.txt'), 'PUBLIC SOURCE')
      const backend = await open(`from strands.experimental.context_manager import ContextManager
from strands.storage import LocalFileStorage
${baseSource
  .replace(
    'def build(**overrides):',
    `@tool
async def stash_note(note: str) -> str:
    """Save content in the context stash.

    Args:
        note: Private content to store.
    """
    await agent.context_manager.stash.store("private-note", 0, note.encode())
    return "saved"

def build(**overrides):`
  )
  .replace('"tools": [status]', '"tools": [status, stash_note]')
  .replace(
    '"context_manager": False',
    `"context_manager": ContextManager(stash={"storage": LocalFileStorage("custom-stash")${namespaced ? '.namespace("")' : ''}})`
  )}`)
      for await (const _event of backend.stream(
        JSON.stringify({ tool: 'stash_note', input: { note: 'PRIVATE STASH SENTINEL' } })
      )) {
        // Drain the actual tool turn before exporting its persisted state.
      }
      const privateDirectory = join(root, 'custom-stash', ...(namespaced ? [] : ['context']))
      expect(backend.privatePaths).toContain(privateDirectory)
      const stored = (await readdir(privateDirectory, { recursive: true })).find((name) =>
        name.endsWith('private-note_0')
      )
      expect(stored).toBeDefined()
      expect(await readFile(join(privateDirectory, stored!), 'utf8')).toBe('PRIVATE STASH SENTINEL')
      const project = { root, entrypoint: join(root, 'agent.py'), language: 'python' as const }
      const archive = join(root, '.agent', 'export.zip')
      await exportSourceProject(project, 'Private context', 'python', backend.privatePaths, archive)
      const files = unzipSync(await readFile(archive))
      expect(Buffer.from(files['public.txt']!).toString()).toBe('PUBLIC SOURCE')
      expect(Object.values(files).some((contents) => Buffer.from(contents).includes('PRIVATE STASH SENTINEL'))).toBe(
        false
      )
      expect(Object.keys(files).some((name) => name.includes('private-note'))).toBe(false)
    }
  )

  it('reports context usage for imported Python agents', async () => {
    const backend = await open(baseSource)

    expect(await runTurn(backend)).toMatchObject({
      context: {
        currentTokens: expect.any(Number),
        projectedTokens: expect.any(Number),
        contextWindow: 1_000,
      },
    })
  })

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
