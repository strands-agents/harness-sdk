import type { JSONValue } from '@strands-agents/sdk'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentExtensionHost } from '../../src/agent/extension.js'
import type { ChatEvent } from '../../src/agent/types.js'
import { CliConfigStore } from '../../src/config/store.js'
import { PythonBackend, type PythonOptions } from '../../src/project/python.js'
import { pythonExecutable as python } from '../fixtures/python-runtime.js'

const source = `from strands_harness import create_harness
from source_reload_model import SourceReloadModel


class EchoSystemModel(SourceReloadModel):
    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        last = messages[-1]["content"][0].get("text", "") if messages[-1]["role"] == "user" else ""
        if last != "echo system":
            async for event in super().stream(messages, tool_specs, system_prompt, **kwargs):
                yield event
            return
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": system_prompt or ""}}}
        yield {"contentBlockStop": {"contentBlockIndex": 0}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}}


def create_agent(**overrides):
    options = dict(
        model=EchoSystemModel(), effort="off", caching=False, instructions="You answer refund questions.",
        builtin_tools=[], builtin_plugins=[], memory=False, session=False, skills=False,
        context_manager=False, background_tasks=False,
    )
    options.update(overrides)
    return create_harness(**options)


agent = create_agent()
`

const withInstructions = (host: AgentExtensionHost, instructions: string): AgentExtensionHost => ({
  ...host,
  extension: { ...host.extension, instructions },
})

const extensionHost = (calls: [string, JSONValue][]): AgentExtensionHost => ({
  extension: {
    instructions: '<strands_dev>\nWorkspace folder: /work/strands-dev\n</strands_dev>',
    skills: [
      { name: 'create-experiment', description: 'Create an experiment', instructions: 'Ask, confirm, then call.' },
    ],
    tools: [
      {
        name: 'strands_dev_status',
        description: 'Show the workspace',
        inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
        readOnly: true,
      },
      { name: 'strands_dev_test', description: 'Run a test', inputSchema: { type: 'object', properties: {} } },
    ],
  },
  call: async (name, input): Promise<string> => {
    calls.push([name, input])
    if (name === 'strands_dev_test') throw new Error('There is no experiment named refunds.')
    return 'two experiments'
  },
})

describe.skipIf(!existsSync(python))('Python agent extension', () => {
  let root: string
  const backends: PythonBackend[] = []

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'strands-python-extension-')))
    await symlink(dirname(dirname(python)), join(root, '.venv'), 'junction')
    await copyFile(new URL('../fixtures/source-reload-model.py', import.meta.url), join(root, 'source_reload_model.py'))
    vi.stubEnv('PYTHONPATH', fileURLToPath(new URL('../../../harness-py/src', import.meta.url)))
    vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1')
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  })

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const open = async (
    calls: [string, JSONValue][],
    options: PythonOptions = {},
    authored = source,
    host = extensionHost(calls)
  ): Promise<PythonBackend> => {
    const entrypoint = join(root, 'agent.py')
    await writeFile(entrypoint, authored)
    const backend = await PythonBackend.open(
      { root, entrypoint, language: 'python' },
      CliConfigStore.memory(),
      { cwd: root, interactive: true, ...options },
      AbortSignal.timeout(15_000),
      host
    )
    backends.push(backend)
    return backend
  }

  const turn = async (backend: PythonBackend, prompt: string): Promise<ChatEvent[]> => {
    const events: ChatEvent[] = []
    for await (const event of backend.stream(prompt)) events.push(event)
    return events
  }

  const text = (events: readonly ChatEvent[]): string =>
    events.flatMap((event) => (event.type === 'textDelta' ? [event.text] : [])).join('')

  it('shouldAppendTheInstructionsAfterTheAuthoredPromptWhenTheAgentStarts', { timeout: 20_000 }, async () => {
    const backend = await open([])

    const prompt = text(await turn(backend, 'echo system'))

    expect(prompt).toContain('You answer refund questions.')
    expect(prompt.indexOf('Workspace folder: /work/strands-dev')).toBeGreaterThan(
      prompt.indexOf('You answer refund questions.')
    )
  })

  it('shouldOfferTheSkillEvenWhenTheAgentTurnsSkillsOff', { timeout: 20_000 }, async () => {
    const backend = await open([])

    expect(backend.skills.map((skill) => skill.name)).toContain('create-experiment')
    expect(backend.info().tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['strands_dev_status', 'strands_dev_test', 'skills'])
    )
  })

  it('shouldRunAReadOnlyToolInTheHostWithoutAskingWhenTheModelCallsIt', { timeout: 20_000 }, async () => {
    const calls: [string, JSONValue][] = []
    const backend = await open(calls)
    const asked: string[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (request) asked.push(request.toolName)
    })

    const events = await turn(backend, JSON.stringify({ tool: 'strands_dev_status', input: { verbose: true } }))
    unwatch()

    expect(calls).toEqual([['strands_dev_status', { verbose: true }]])
    expect(asked).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        status: 'success',
        content: [{ type: 'text', text: 'two experiments' }],
      })
    )
  })

  it('shouldAskFirstAndReturnTheHostErrorWhenTheModelCallsAToolThatRuns', { timeout: 20_000 }, async () => {
    const calls: [string, JSONValue][] = []
    const backend = await open(calls)
    const asked: string[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (!request) return
      asked.push(request.toolName)
      backend.respondPermission(request.id, 'allow-once')
    })

    const events = await turn(backend, JSON.stringify({ tool: 'strands_dev_test' }))
    unwatch()

    expect(asked).toEqual(['strands_dev_test'])
    expect(calls).toEqual([['strands_dev_test', {}]])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        status: 'error',
        content: [{ type: 'text', text: 'There is no experiment named refunds.' }],
      })
    )
  })

  it('shouldKeepOnlyTheNewInstructionsWhenASavedSessionHoldsOlderOnes', { timeout: 30_000 }, async () => {
    const resumable = source.replace('session=False', 'session=True')
    const first = await open(
      [],
      { sessionId: 'saved-session' },
      resumable,
      withInstructions(extensionHost([]), '<strands_dev>\nold workspace\n</strands_dev>')
    )
    await turn(first, 'echo system')
    await first.dispose()

    const resumed = await open(
      [],
      { sessionId: 'saved-session', resume: true },
      resumable,
      withInstructions(extensionHost([]), '<strands_dev>\nnew workspace\n</strands_dev>')
    )
    const prompt = text(await turn(resumed, 'echo system'))

    expect(prompt).toContain('You answer refund questions.')
    expect(prompt).toContain('new workspace')
    expect(prompt).not.toContain('old workspace')
    expect(prompt.match(/<strands_dev>/gu)).toHaveLength(1)
  })
})
