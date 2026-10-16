import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatEvent, ChatRunResult } from '../src/tui/chat/types.js'
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

  async function runTurn(backend: PythonBackend): Promise<ChatRunResult> {
    const stream = backend.stream(JSON.stringify({ tool: 'status' }))
    let next = await stream.next()
    while (!next.done) {
      next = await stream.next()
    }
    return next.value
  }

  it('reports the effective context composition for imported Python agents', async () => {
    const backend = await open(
      baseSource.replace(
        'agent = build()',
        `
from dataclasses import replace
from strands._middleware import InvokeModelStage
from strands.hooks.events import BeforeModelCallEvent

class ContextModel(SourceReloadModel):
    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        assert system_prompt == "A" * 400
        async for event in super().stream(messages, tool_specs, system_prompt, **kwargs):
            if "metadata" in event:
                event = {"metadata": {"usage": {
                    "inputTokens": 100_000, "outputTokens": 20, "totalTokens": 100_020
                }}}
            yield event

agent = build(model=ContextModel(), instructions="Follow the authored instructions.")

def inject(context):
    messages = [*context.messages]
    last_user = next(index for index in range(len(messages) - 1, -1, -1) if messages[index]["role"] == "user")
    messages[last_user] = {
        **messages[last_user],
        "content": [*messages[last_user]["content"], {"text": "Temporary guidance for this request."}],
    }
    return replace(context, messages=messages, dynamic_trailing_blocks=1)

agent._middleware_registry.add_middleware(InvokeModelStage.Input, inject)

async def transform(context, next_handler):
    async for event in next_handler(replace(context, system_prompt="A" * 400)):
        yield event

registered = False
def register_transform(event):
    global registered
    if not registered:
        event.agent._middleware_registry.add_middleware(InvokeModelStage, transform)
        registered = True

agent.hooks.add_callback(BeforeModelCallEvent, register_transform)
`
      )
    )

    const result = await runTurn(backend)
    expect(result).toMatchObject({
      context: {
        currentTokens: 100_000,
        projectedTokens: 100_020,
        contextWindow: 1_000,
      },
    })
    const categories = result.context!.breakdown!.categories
    expect(categories.map(({ kind }) => kind)).toEqual([
      'systemPrompt',
      'tools',
      'userMessages',
      'assistantMessages',
      'toolResults',
      'injectedContext',
      'other',
    ])
    expect(categories.reduce((sum, { tokens }) => sum + tokens, 0)).toBe(100_020)
    expect(categories.find(({ kind }) => kind === 'systemPrompt')!.tokens).toBe(100)
    expect(categories.find(({ kind }) => kind === 'injectedContext')!.tokens).toBe(9)
    expect(categories.find(({ kind }) => kind === 'assistantMessages')!.tokens).toBeGreaterThanOrEqual(20)
    expect(JSON.stringify(result.context)).not.toContain('Temporary guidance')
  })

  it('keeps aggregate context usage when the Python SDK lacks model middleware capture', async () => {
    const backend = await open(`${baseSource}
import strands._middleware
del strands._middleware.InvokeModelStage
`)
    const result = await runTurn(backend)

    expect(result.context).toMatchObject({
      currentTokens: expect.any(Number),
      projectedTokens: expect.any(Number),
      contextWindow: 1_000,
    })
    expect(result.context?.breakdown).toBeUndefined()
  })

  it('omits a stale breakdown when the final Python model call reports no usage', async () => {
    const backend = await open(
      baseSource.replace(
        'agent = build()',
        `
class PartialUsageModel(SourceReloadModel):
    async def stream(self, messages, *args, **kwargs):
        completed = any("toolResult" in block for block in messages[-1]["content"])
        async for event in super().stream(messages, *args, **kwargs):
            if completed and "metadata" in event:
                continue
            yield event

agent = build(model=PartialUsageModel())
`
      )
    )

    expect((await runTurn(backend)).context?.breakdown).toBeUndefined()
  })

  it('passes image attachment bytes through the Python worker', async () => {
    const backend = await open(baseSource)
    const events: ChatEvent[] = []

    for await (const event of backend.stream([
      { text: 'Describe this image.' },
      { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
    ])) {
      events.push(event)
    }

    expect(events).toContainEqual({ type: 'textDelta', text: 'Received png image with 3 bytes.' })
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
    await expect(backend.activateSkill('discovered-skill')).resolves.toMatchObject({
      skill: { name: 'discovered-skill', active: true },
      content: expect.stringContaining('Use the discovered skill.'),
    })
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
