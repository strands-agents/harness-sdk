import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'

import type { ChatEvent, ChatPermissionRequest, ChatRunResult } from '../src/tui/chat/types.js'
import { CliConfigStore } from '../src/tui/config.js'
import { PythonBackend, type PythonOptions } from '../src/tui/project/python.js'
import { exportSourceProject } from '../src/tui/project/export.js'
import { createPythonChat } from '../src/tui/project/run.js'
import type { ConversationManager } from '../src/tui/session/conversations.js'
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
  const chats: ConversationManager[] = []

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
    await Promise.all(chats.splice(0).map((chat) => chat.dispose()))
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

  it.each(['True', '{"dir": "custom-sessions"}', 'False'])(
    'rejects missing saved sessions without creating one when session=%s',
    async (session) => {
      const source = baseSource
        .replace('"session": False', `"session": ${session}`)
        .replace(
          'agent = build()',
          'def create_agent(**overrides):\n    return build(**overrides)\n\nagent = create_agent()'
        )

      await expect(open(source, { sessionId: 'missing-session', resume: true })).rejects.toThrow(
        'No saved Python session'
      )

      const sessions = session.includes('custom-sessions') ? 'custom-sessions' : '.agent/sessions'
      expect(existsSync(join(root, sessions, 'session', 'missing-session'))).toBe(false)
    }
  )

  it.each(['True', '{"dir": "custom-sessions"}'])('restores saved history when session=%s', async (session) => {
    const source = baseSource
      .replace('"session": False', `"session": ${session}`)
      .replace(
        'agent = build()',
        'def create_agent(**overrides):\n    return build(**overrides)\n\nagent = create_agent()'
      )
    const previous = await open(source, { sessionId: 'saved-session' })
    await runTurn(previous)
    const history = previous.messages.map((message) => ({ role: message.role, content: message.toJSON().content }))
    await previous.dispose()

    const restored = await open(source, { sessionId: 'saved-session', resume: true })

    expect(restored.messages.map((message) => ({ role: message.role, content: message.toJSON().content }))).toEqual(
      history
    )
    expect(restored.sessionIdentity?.sessionId).toBe('saved-session')
    expect((await runTurn(restored)).stopReason).toBe('end_turn')
  })

  it.each(['False', 'True', '{}', '{"id": "authored", "dir": "custom-sessions"}'])(
    'restores the complete roster with authored session=%s',
    async (session) => {
      const entrypoint = join(root, 'agent.py')
      const source = baseSource.replace(
        'agent = build()',
        `agent = create_harness(
    model=SourceReloadModel(), effort="off", caching=False, builtin_tools=[], builtin_plugins=[],
    tools=[status], memory=False, session=${session}, skills=False, context_manager=False, background_tasks=False,
)`
      )
      await writeFile(entrypoint, source)
      const config = CliConfigStore.memory()
      await config.setPermissionMode('bypassPermissions')
      const options = { cwd: root }
      const requestSetup = vi.fn()
      const previous = await createPythonChat(entrypoint, config, options, AbortSignal.timeout(30_000), requestSetup)
      chats.push(previous)
      await previous.submit('{"tool":"status","chat":"primary"}')
      await previous.submit('/fork')
      await previous.submit('{"tool":"status","chat":"fork"}')
      const captured = await previous.captureConversations()
      expect(captured.entries).toHaveLength(2)
      expect(captured.activeId).toBe('agent-2')
      await writeFile(entrypoint, source.replace('"authored tool"', '"updated tool"'))
      const current = await createPythonChat(
        entrypoint,
        config,
        options,
        AbortSignal.timeout(30_000),
        requestSetup,
        captured,
        'agent-1'
      )
      chats.push(current)
      const restored = await current.captureConversations()
      expect(restored.activeId).toBe(captured.activeId)
      expect(
        restored.entries.map(({ id, title, description, conversation }) => ({
          id,
          title,
          description,
          turns: conversation.completedTurns,
          session: conversation.session,
        }))
      ).toEqual(
        captured.entries.map(({ id, title, description, conversation }) => ({
          id,
          title,
          description,
          turns: conversation.completedTurns,
          session: conversation.session,
        }))
      )
      expect(restored.entries.map(({ conversation }) => conversation.snapshot.data)).toEqual(
        captured.entries.map(({ conversation }) => conversation.snapshot.data)
      )
      if (session === 'False') {
        expect(restored.entries.every(({ conversation }) => conversation.session === undefined)).toBe(true)
      } else {
        expect(restored.entries.every(({ conversation }) => conversation.session !== undefined)).toBe(true)
        const repeated = await createPythonChat(
          entrypoint,
          config,
          options,
          AbortSignal.timeout(30_000),
          requestSetup,
          restored,
          'agent-1'
        )
        chats.push(repeated)
        expect((await repeated.captureConversations()).entries.map(({ conversation }) => conversation.session)).toEqual(
          restored.entries.map(({ conversation }) => conversation.session)
        )
      }
      if (session.includes('authored')) {
        await writeFile(
          entrypoint,
          source.replace('"authored"', '"changed"').replace('custom-sessions', 'changed-sessions')
        )
        const changed = await createPythonChat(
          entrypoint,
          config,
          options,
          AbortSignal.timeout(30_000),
          requestSetup,
          restored,
          'agent-1'
        )
        chats.push(changed)
        const changedState = await changed.captureConversations()
        expect(changedState.entries[0]!.conversation.session).toMatchObject({
          sessionId: 'changed',
          sessionDirectory: join(root, 'changed-sessions', 'session'),
        })
        expect(changedState.entries[1]!.conversation.session?.sessionId).toBe(
          restored.entries[1]!.conversation.session?.sessionId
        )
        expect(changedState.entries[1]!.conversation.session?.sessionDirectory).toBe(
          restored.entries[1]!.conversation.session?.sessionDirectory
        )
      }
      await current.submit('/fork')
      expect((await current.captureConversations()).activeId).toBe('agent-3')
    },
    30_000
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

  it('previews Python edits using literal replacement text', async () => {
    const path = join(root, 'sample.txt')
    await writeFile(path, 'alpha')
    const backend = await open(baseSource.replace('"builtin_tools": []', '"builtin_tools": ["edit"]'), {
      interactive: true,
    })
    const requests: ChatPermissionRequest[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (!request) return
      requests.push(request)
      backend.respondPermission(request.id, 'allow-once')
    })
    try {
      const replacement = "$& $$ $` $'"
      for await (const event of backend.stream(
        JSON.stringify({ tool: 'edit', input: { path, old_str: 'alpha', new_str: replacement } })
      )) {
        if (event.type === 'toolResult') expect(event.status).toBe('success')
      }
      expect(await readFile(path, 'utf8')).toBe(replacement)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.diff?.lines).toContainEqual(expect.objectContaining({ kind: 'add', text: replacement }))
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

  it.each([
    { capture: false, fail: false },
    { capture: false, fail: true },
    { capture: true, fail: false },
    { capture: true, fail: true },
  ])('flushes memory before reconstruction or handoff: capture=$capture fail=$fail', async ({ capture, fail }) => {
    const backend = await open(
      `import json
from pathlib import Path
from strands.memory import MemoryManager
from strands.memory.types import MemoryStore
from strands.memory.extraction.triggers import IntervalTrigger

class Store(MemoryStore):
    name = "buffered"
    writable = True
    description = None
    max_search_results = None
    extraction = {"trigger": IntervalTrigger(turns=100)}
    async def search(self, query, options=None):
        return []
    async def add_messages(self, messages, context):
        path = Path("saved.json")
        saved = json.loads(path.read_text()) if path.exists() else []
        path.write_text(json.dumps(saved + messages))

class Manager(MemoryManager):
    async def flush(self):
        if Path("fail-flush").exists():
            raise RuntimeError("memory flush failed")
        await super().flush()

manager = Manager(stores=[Store()], injection=False, search_tool_config=False)
${baseSource.replace('"memory": False', '"memory": manager').replace(
  'agent = build()',
  `def create_agent(**overrides):
    path = Path("build-count")
    path.write_text(str(int(path.read_text()) + 1) if path.exists() else "1")
    saved = Path("saved.json")
    Path("factory-seen").write_text(str(len(json.loads(saved.read_text())) if saved.exists() else 0))
    return build(**overrides)

agent = create_agent()`
)}`
    )
    await runTurn(backend)
    const change = () => (capture ? backend.captureConversation() : backend.clear())
    if (fail) {
      const messages = backend.messages.map((message) => ({ role: message.role, content: message.toJSON().content }))
      await writeFile(join(root, 'fail-flush'), '')
      await expect(change()).rejects.toThrow('memory flush failed')
      expect(await readFile(join(root, 'build-count'), 'utf8')).toBe('1')
      expect(backend.messages.map((message) => ({ role: message.role, content: message.toJSON().content }))).toEqual(
        messages
      )
      await rm(join(root, 'fail-flush'))
      expect((await runTurn(backend)).stopReason).toBe('end_turn')
    }
    await change()
    if (capture) {
      expect(backend.messages.length).toBeGreaterThan(0)
      await open(await readFile(join(root, 'agent.py'), 'utf8'))
    } else {
      expect(backend.messages).toEqual([])
    }
    expect(await readFile(join(root, 'factory-seen'), 'utf8')).toBe(fail ? '4' : '2')
    await backend.dispose()
    await backend.dispose()
    const saved = JSON.parse(await readFile(join(root, 'saved.json'), 'utf8')) as unknown[]
    expect(saved).toHaveLength(fail ? 4 : 2)
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
