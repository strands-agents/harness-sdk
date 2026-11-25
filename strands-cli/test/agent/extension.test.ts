import { TextBlock, type Agent, type InvokableTool, type JSONValue, type ToolContext } from '@strands-agents/sdk'
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addExtensionSkills,
  appendInstructions,
  extensionPolicies,
  extensionTools,
  type AgentExtension,
  type AgentExtensionHost,
} from '../../src/agent/extension.js'
import { AgentMessaging } from '../../src/agent/messaging.js'
import type { ChatEvent } from '../../src/agent/types.js'
import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { evalsWorkflowSkills } from '../../src/dev/evals/chat/workflow-skills.js'
import { exportSourceProject } from '../../src/project/export.js'
import { importAgentProject } from '../../src/project/import.js'
import { PythonBackend, type PythonOptions } from '../../src/project/python.js'
import { TypescriptBackend } from '../../src/project/typescript-backend.js'
import { pythonExecutable as python } from '../fixtures/python-runtime.js'

const EXTENSION: AgentExtension = {
  instructions: '<strands_dev>workspace</strands_dev>',
  skills: [{ name: 'create-experiment', description: 'Create an experiment', instructions: 'Ask, then call.' }],
  tools: [
    { name: 'strands_dev_status', description: 'Status', inputSchema: { type: 'object' }, readOnly: true },
    { name: 'strands_dev_test', description: 'Test', inputSchema: { type: 'object' } },
  ],
}

const agentWith = (systemPrompt: Agent['systemPrompt']): Agent => ({ systemPrompt }) as Agent

describe('appendInstructions', () => {
  it.each<[string, Agent['systemPrompt'], Agent['systemPrompt']]>([
    ['no prompt', undefined, 'extra'],
    ['an empty prompt', '', 'extra'],
    ['a text prompt', 'authored', 'authored\n\nextra'],
  ])('shouldPutTheInstructionsLastWhenTheAgentHas%s', (_case, before, after) => {
    const agent = agentWith(before)

    appendInstructions(agent, 'extra')
    appendInstructions(agent, 'extra')

    expect(agent.systemPrompt).toEqual(after)
  })

  it('shouldAddOneTextBlockWhenThePromptIsMadeOfBlocks', () => {
    const agent = agentWith([new TextBlock('authored')])

    appendInstructions(agent, 'extra')
    appendInstructions(agent, 'extra')

    expect(agent.systemPrompt).toEqual([new TextBlock('authored'), new TextBlock('extra')])
  })
})

describe('extensionTools', () => {
  it('shouldSendTheToolNameAndInputToTheHostWhenTheAgentCallsATool', async () => {
    const call = vi.fn(async (_name: string, _input: JSONValue) => 'ok')

    const tools = extensionTools({ extension: EXTENSION, call })
    const result = await (tools[1] as InvokableTool<unknown, JSONValue>).invoke({ experiment: 'refunds' })

    expect(tools.map((tool) => tool.name)).toEqual(['strands_dev_status', 'strands_dev_test'])
    expect(call).toHaveBeenCalledWith('strands_dev_test', { experiment: 'refunds' })
    expect(result).toBe('ok')
  })
})

describe('extensionTools cancellation', () => {
  it('shouldEndTheToolCallWhenTheTurnIsCancelledWhileTheHostStillRuns', async () => {
    const call = vi.fn(() => new Promise<string>(() => undefined))
    const controller = new AbortController()
    const [, test] = extensionTools({ extension: EXTENSION, call })

    const running = (test as InvokableTool<unknown, JSONValue>).invoke({}, {
      cancelSignal: controller.signal,
    } as ToolContext)
    controller.abort()

    await expect(running).rejects.toThrow('The tool call was cancelled.')
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('extensionPolicies', () => {
  it('shouldPermitOnlyTheReadOnlyToolsWhenItWritesCedarPolicies', () => {
    const policies = extensionPolicies(EXTENSION)

    expect(policies).toContain('action == Action::"strands_dev_status"')
    expect(policies).not.toContain('strands_dev_test')
  })
})

describe('addExtensionSkills', () => {
  it('shouldKeepTheAuthoredSkillsAndReplaceASkillWithTheSameNameWhenItAddsTheExtensionSkills', async () => {
    const plugin = new AgentSkills({
      skills: [
        new Skill({ name: 'refunds', description: 'Authored', instructions: 'Refund rules.' }),
        new Skill({ name: 'create-experiment', description: 'Old', instructions: 'Old text.' }),
      ],
    })
    const agent = {} as Agent

    await addExtensionSkills(plugin, agent, EXTENSION)

    const skills = await plugin.getAvailableSkills()
    expect(skills.map(({ name, description }) => [name, description])).toEqual([
      ['refunds', 'Authored'],
      ['create-experiment', 'Create an experiment'],
    ])
  })
})

const pythonSource = `from strands_harness import create_harness
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
    skills: evalsWorkflowSkills(),
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

const turn = async (backend: PythonBackend | TypescriptBackend, prompt: string): Promise<ChatEvent[]> => {
  const events: ChatEvent[] = []
  for await (const event of backend.stream(prompt)) events.push(event)
  return events
}

const text = (events: readonly ChatEvent[]): string =>
  events.flatMap((event) => (event.type === 'textDelta' ? [event.text] : [])).join('')

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
    authored = pythonSource,
    host: AgentExtensionHost | null = extensionHost(calls)
  ): Promise<PythonBackend> => {
    const entrypoint = join(root, 'agent.py')
    await writeFile(entrypoint, authored)
    const backend = await PythonBackend.open(
      { root, entrypoint, language: 'python' },
      CliConfigStore.memory(),
      { cwd: root, interactive: true, ...options },
      AbortSignal.timeout(15_000),
      host ?? undefined
    )
    backends.push(backend)
    return backend
  }

  it('shouldAppendTheInstructionsAfterTheAuthoredPromptWhenTheAgentStarts', { timeout: 20_000 }, async () => {
    const backend = await open([])

    const prompt = text(await turn(backend, 'echo system'))

    expect(prompt).toContain('You answer refund questions.')
    expect(prompt.indexOf('Workspace folder: /work/strands-dev')).toBeGreaterThan(
      prompt.indexOf('You answer refund questions.')
    )
  })

  it('shouldKeepTheDevSkillOutOfStandaloneExportsAndPlainAgentLoads', { timeout: 30_000 }, async () => {
    const dev = await open([])
    expect(dev.skills.map(({ name }) => name)).toContain('background-evals')
    expect(dev.skills.map(({ name }) => name)).toEqual(
      expect.arrayContaining(evalsWorkflowSkills().map(({ name }) => name))
    )
    expect(text(await turn(dev, 'echo system'))).toContain('<strands_dev>')

    const destination = join(root, 'exported-agent')
    await exportSourceProject(
      { root, entrypoint: join(root, 'agent.py'), language: 'python' },
      'Refunds',
      'python',
      [],
      destination,
      'directory'
    )
    const exported = await readFile(join(destination, 'agent.py'), 'utf8')
    expect(exported).toBe(pythonSource)
    expect(exported).not.toContain('background-evals')
    for (const { name } of evalsWorkflowSkills()) expect(exported).not.toContain(name)
    expect(exported).not.toContain('strands_dev')

    const plain = await open([], {}, pythonSource, null)
    expect(text(await turn(plain, 'echo system'))).not.toContain('<strands_dev>')
    expect(plain.skills.map(({ name }) => name)).not.toContain('background-evals')
    for (const { name } of evalsWorkflowSkills()) expect(plain.skills.map((skill) => skill.name)).not.toContain(name)
    expect(plain.info().tools?.some(({ name }) => name.startsWith('strands_dev_'))).toBe(false)
    expect(await readFile(join(root, 'agent.py'), 'utf8')).toBe(pythonSource)
  })

  it('shouldOfferTheSkillEvenWhenTheAgentTurnsSkillsOff', { timeout: 20_000 }, async () => {
    const backend = await open([])

    expect(backend.skills.map((skill) => skill.name)).toContain('background-evals')
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
    const resumable = pythonSource.replace('session=False', 'session=True')
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

const typescriptSource = `
import { createHarness } from '@strands-agents/harness'
import { Model } from '@strands-agents/sdk'
const lastUserText = (messages) => {
  const last = messages.at(-1)
  return last?.role === 'user' ? last.content.find((block) => block.type === 'textBlock')?.text ?? '' : ''
}
const promptText = (prompt) =>
  typeof prompt === 'string' ? prompt : (prompt ?? []).map((block) => block.text ?? '').join('\\n')
class LocalModel extends Model {
  getConfig() { return { modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', contextWindowLimit: 10000 } }
  updateConfig() {}
  async *stream(messages, options) {
    const text = lastUserText(messages)
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (text.startsWith('{')) {
      const request = JSON.parse(text)
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: request.tool, toolUseId: 'call-1' } }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(request.input ?? {}) } }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
      return
    }
    const reply = text === 'echo system' ? promptText(options?.systemPrompt) : 'done'
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: reply } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}
export const agent = await createHarness({
  model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0', effort: 'off', caching: false,
  instructions: 'You answer refund questions.', builtinTools: [], builtinPlugins: [], memory: false,
  session: false, skills: false, contextManager: false, agentConfig: { backgroundTasks: false, printer: false },
})
agent.model = new LocalModel()
`

describe('TypeScript agent extension', () => {
  let root: string
  const backends: TypescriptBackend[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-typescript-extension-'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'agent.ts'), typescriptSource)
  })

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  const open = async (calls: [string, JSONValue][], dev = true): Promise<TypescriptBackend> => {
    const config = CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false })
    const { backend } = await TypescriptBackend.open(
      {
        project: importAgentProject(join(root, 'agent.ts')),
        args: parseArgs([]),
        cwd: root,
        initialWorkspace: root,
        peerEndpointId: 'agent-1',
        mcpPaths: [],
        mcpStrictPaths: [],
      },
      config,
      new AgentMessaging(),
      AbortSignal.timeout(15_000),
      dev ? extensionHost(calls) : undefined
    )
    backends.push(backend)
    return backend
  }

  it('shouldAppendTheInstructionsAfterTheAuthoredPromptWhenTheAgentStarts', { timeout: 30_000 }, async () => {
    const backend = await open([])

    const prompt = text(await turn(backend, 'echo system'))

    expect(prompt).toContain('You answer refund questions.')
    expect(prompt.indexOf('Workspace folder: /work/strands-dev')).toBeGreaterThan(
      prompt.indexOf('You answer refund questions.')
    )
  })

  it('shouldKeepTheDevSkillOutOfStandaloneExportsAndPlainAgentLoads', { timeout: 30_000 }, async () => {
    const dev = await open([])
    expect((await dev.skills.list()).map(({ name }) => name)).toContain('background-evals')
    expect((await dev.skills.list()).map(({ name }) => name)).toEqual(
      expect.arrayContaining(evalsWorkflowSkills().map(({ name }) => name))
    )
    expect(text(await turn(dev, 'echo system'))).toContain('<strands_dev>')
    expect(JSON.stringify(dev.state.profile)).not.toContain('background-evals')
    expect(JSON.stringify(dev.state.profile)).not.toContain('strands_dev')

    const destination = join(root, 'exported-agent')
    await exportSourceProject(
      importAgentProject(join(root, 'agent.ts')),
      'Refunds',
      'typescript',
      [],
      destination,
      'directory'
    )
    const exported = await readFile(join(destination, 'agent.ts'), 'utf8')
    expect(exported).toBe(typescriptSource)
    expect(exported).not.toContain('background-evals')
    for (const { name } of evalsWorkflowSkills()) expect(exported).not.toContain(name)
    expect(exported).not.toContain('strands_dev')

    const plain = await open([], false)
    expect(text(await turn(plain, 'echo system'))).not.toContain('<strands_dev>')
    expect((await plain.skills.list()).map(({ name }) => name)).not.toContain('background-evals')
    for (const { name } of evalsWorkflowSkills())
      expect((await plain.skills.list()).map((skill) => skill.name)).not.toContain(name)
    expect(plain.info().tools?.some(({ name }) => name.startsWith('strands_dev_'))).toBe(false)
    expect(await readFile(join(root, 'agent.ts'), 'utf8')).toBe(typescriptSource)
  })

  it('shouldOfferTheSkillEvenWhenTheAgentTurnsSkillsOff', { timeout: 30_000 }, async () => {
    const backend = await open([])

    expect((await backend.skills.list()).map((skill) => skill.name)).toContain('background-evals')
    expect(backend.info().tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['strands_dev_status', 'strands_dev_test'])
    )
  })

  it('shouldRunAReadOnlyToolInTheHostWithoutAskingWhenTheModelCallsIt', { timeout: 30_000 }, async () => {
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

  it('shouldAskFirstAndReturnTheHostErrorWhenTheModelCallsAToolThatRuns', { timeout: 30_000 }, async () => {
    const calls: [string, JSONValue][] = []
    const backend = await open(calls)
    const asked: string[] = []
    const unwatch = backend.watchPermissions((request) => {
      if (!request) return
      asked.push(request.toolName)
      void backend.respondPermission(request.id, 'allow-once')
    })

    const events = await turn(backend, JSON.stringify({ tool: 'strands_dev_test' }))
    unwatch()

    expect(asked).toEqual(['strands_dev_test'])
    expect(calls).toEqual([['strands_dev_test', {}]])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'toolResult',
        status: 'error',
        content: [expect.objectContaining({ text: expect.stringContaining('There is no experiment named refunds.') })],
      })
    )
  })
})
