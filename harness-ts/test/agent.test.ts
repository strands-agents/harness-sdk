import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  Agent,
  BeforeModelCallEvent,
  FileStorage as SessionFileStorage,
  type InterventionHandler,
  McpClient,
  MemoryManager,
  ModelRouter,
  type Plugin,
  SessionManager,
  Tool,
  tool,
  type ToolContext,
} from '@strands-agents/sdk'
import { ContextManager } from '@strands-agents/sdk/experimental'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { DockerSandbox } from '@strands-agents/sdk/sandbox/docker'
import { makeFileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { makeShell } from '@strands-agents/sdk/vended-tools/shell'
import { makeShell as makeShellFactory } from '@strands-agents/sdk/vended-tools/bash'
import { ContextOffloader, FileStorage } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { z } from 'zod'

import { createHarness } from '../src/agent.js'
import { HARNESS_CONTRACT } from '../src/prompt.js'
import { configureLogging, resetWarnOnce } from '../src/logging.js'
import { makeProgrammaticToolCaller } from '../src/tools/programmatic-tool-caller.js'
import { buildDefaultSubagent } from '../src/builtin-tools.js'
import { AgentSpec, makeSubagent } from '../src/tools/subagent.js'
import type { HarnessAgentOptions } from '../src/agent.js'
import { storeOf } from './memory-internals.js'

// Wrap the configurable built-ins' factories so tests can see the config each was built with.
vi.mock('@strands-agents/sdk/vended-tools/bash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@strands-agents/sdk/vended-tools/bash')>()
  return { ...actual, makeShell: vi.fn(actual.makeShell) }
})
vi.mock('../src/tools/programmatic-tool-caller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/programmatic-tool-caller.js')>()
  return { ...actual, makeProgrammaticToolCaller: vi.fn(actual.makeProgrammaticToolCaller) }
})
vi.mock('../src/tools/subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/subagent.js')>()
  return { ...actual, makeSubagent: vi.fn(actual.makeSubagent) }
})

const sampleTool = tool({
  name: 'sample_tool',
  description: 'A sample tool.',
  inputSchema: z.object({ x: z.string() }),
  callback: ({ x }) => x,
})

function toolNames(agent: Agent): string[] {
  return agent.tools.map((t) => t.name)
}

function conversationManagerName(agent: Agent): string | undefined {
  return (agent as unknown as { _conversationManager?: object })._conversationManager?.constructor?.name
}

function plugins(agent: Agent): Plugin[] {
  const registry = (agent as unknown as { _pluginRegistry: { _plugins: Map<string, Plugin>; _pending?: Plugin[] } })
    ._pluginRegistry
  return [...registry._plugins.values(), ...(registry._pending ?? [])]
}

function offloaders(agent: Agent): ContextOffloader[] {
  return plugins(agent).filter((p): p is ContextOffloader => p instanceof ContextOffloader)
}

function skills(agent: Agent): AgentSkills[] {
  return plugins(agent).filter((p): p is AgentSkills => p instanceof AgentSkills)
}

function backgroundTaskPolicy(agent: Agent): ReadonlyMap<string, string> | undefined {
  return (
    plugins(agent).find((plugin) => plugin.name === 'strands:background-tasks') as
      { _policy: ReadonlyMap<string, string> } | undefined
  )?._policy
}

function interventionHandlers(agent: Agent): InterventionHandler[] {
  return (agent as unknown as { _interventionRegistry: { handlers: InterventionHandler[] } })._interventionRegistry
    .handlers
}

function offloadDir(offloader: ContextOffloader): string {
  return (offloader as unknown as { _storage: { _artifactDir: string } })._storage._artifactDir
}

function writeSkill(skillsDir: string, name: string): void {
  const skill = join(skillsDir, name)
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A ${name} skill.\n---\nDo the ${name} thing.\n`
  )
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = join(tmpdir(), `strands-test-${tempDirs.length}-${process.pid}`)
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  resetWarnOnce()
})

describe('createHarness', () => {
  it('builds an agent with the default configuration', async () => {
    const agent = await createHarness()
    expect(agent).toBeInstanceOf(Agent)
    for (const name of ['shell', 'read', 'write', 'edit', 'web_fetch']) {
      expect(toolNames(agent)).toContain(name)
    }
    expect(agent.systemPrompt).toBe(HARNESS_CONTRACT)
    expect(agent.contextManager).toBeInstanceOf(ContextManager)
  })

  it('attaches a ModelRouter through the model parameter', async () => {
    const defaultModel = new BedrockModel({ modelId: 'fast' })
    const router = new ModelRouter([defaultModel, new BedrockModel({ modelId: 'deep' })])

    const agent = await createHarness({ model: router })

    expect((agent as unknown as { _modelRouter: unknown })._modelRouter).toBe(router)
    expect(agent.model).toBe(defaultModel)
  })

  it('backgrounds the subagent and leaves other compatible tools agent-selectable', async () => {
    const agent = await createHarness()

    expect([...backgroundTaskPolicy(agent)!]).toEqual([
      ['*', 'agentic'],
      ['subagent', 'always'],
    ])
  })

  it('treats backgroundTasks true the same as the default', async () => {
    const agent = await createHarness({ backgroundTasks: true })

    expect([...backgroundTaskPolicy(agent)!]).toEqual([
      ['*', 'agentic'],
      ['subagent', 'always'],
    ])
  })

  it('keeps the subagent backgrounded under a custom policy', async () => {
    const agent = await createHarness({
      backgroundTasks: {
        always: ['sample_tool', 'subagent'],
        never: ['*', 'subagent'],
        waitForCompletion: false,
      },
    })

    expect([...backgroundTaskPolicy(agent)!]).toEqual([
      ['sample_tool', 'always'],
      ['subagent', 'always'],
      ['*', 'never'],
    ])
  })

  it('disables Background Tasks when requested', async () => {
    const agent = await createHarness({ backgroundTasks: false })

    expect(backgroundTaskPolicy(agent)).toBeUndefined()
  })

  it('appends instructions after the contract', async () => {
    const agent = await createHarness({ instructions: 'You are a migration assistant.' })
    const prompt = agent.systemPrompt as string
    expect(prompt.startsWith(HARNESS_CONTRACT)).toBe(true)
    expect(prompt.endsWith('You are a migration assistant.')).toBe(true)
  })

  it('lets an explicit system prompt win over instructions', async () => {
    const agent = await createHarness({ instructions: 'ignored', systemPrompt: 'my own prompt' })
    expect(agent.systemPrompt).toBe('my own prompt')
  })

  it('adds consumer tools alongside the built-ins', async () => {
    const agent = await createHarness({ tools: [sampleTool] })
    const names = new Set(toolNames(agent))
    expect(names.has('shell')).toBe(true)
    expect(names.has('read')).toBe(true)
    expect(names.has('sample_tool')).toBe(true)
  })

  it('enables the subagent delegation tool by default', async () => {
    const agent = await createHarness()
    expect(toolNames(agent)).toContain('subagent')
  })

  it('disables the subagent tool when dropped from builtinTools', async () => {
    const agent = await createHarness({ builtinTools: ['read'] })
    expect(toolNames(agent)).not.toContain('subagent')
  })

  it('selects a subset of built-in tools', async () => {
    const agent = await createHarness({ builtinTools: ['read'] })
    expect(toolNames(agent)).toContain('read')
    expect(toolNames(agent)).not.toContain('shell')
  })

  it('edits the defaults with a builtinTools mapping', async () => {
    const agent = await createHarness({ builtinTools: { subagent: false } })
    expect(toolNames(agent)).not.toContain('subagent')
    for (const name of ['shell', 'read', 'write', 'edit', 'web_fetch']) {
      expect(toolNames(agent)).toContain(name)
    }
  })

  it('starts from nothing when the builtinTools mapping sets "*" to false', async () => {
    const agent = await createHarness({ builtinTools: { '*': false, read: true, web_fetch: {} } })
    expect(
      toolNames(agent)
        .filter((name) => name !== 'todo_write')
        .sort()
    ).toEqual(['read', 'web_fetch'])
  })

  it('rejects an unknown name in a builtinTools mapping', async () => {
    await expect(createHarness({ builtinTools: { grep: true } as never })).rejects.toThrow(
      'Unknown built-in tool "grep"'
    )
  })

  it('rejects a config object on a built-in that takes none', async () => {
    await expect(createHarness({ builtinTools: { write: {} } as never })).rejects.toThrow(
      'Built-in tool "write" takes no config'
    )
  })

  it('rejects an unknown per-tool config key', async () => {
    await expect(createHarness({ builtinTools: { shell: { model: 'x' } } as never })).rejects.toThrow(
      'Unknown shell config keys: model. Allowed: description.'
    )
  })

  it.each([
    ['shell', { description: 'Run a command.' }, makeShellFactory, [{ description: 'Run a command.' }]],
    [
      'programmatic_tool_caller',
      { allowedTools: ['read'], timeout: 60 },
      makeProgrammaticToolCaller,
      [{ allowedTools: ['read'], timeoutMs: 60_000 }],
    ],
    ['programmatic_tool_caller', { timeout: null }, makeProgrammaticToolCaller, [{ timeoutMs: null }]],
    ['subagent', { maxDepth: 1 }, makeSubagent, [expect.objectContaining({ maxDepth: 1 })]],
  ] as const)('builds %s from its factory with its per-tool config', async (name, config, factory, args) => {
    vi.mocked(factory).mockClear()
    const agent = await createHarness({ builtinTools: { [name]: config } })
    expect(toolNames(agent)).toContain(name)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenLastCalledWith(...args)
  })

  it.each([
    ['shell', makeShellFactory, [{}]],
    ['programmatic_tool_caller', makeProgrammaticToolCaller, [{}]],
    ['subagent', makeSubagent, [expect.not.objectContaining({ maxDepth: expect.anything() })]],
  ] as const)('builds %s from its factory with no config when enabled with true', async (name, factory, args) => {
    vi.mocked(factory).mockClear()
    await createHarness({ builtinTools: { [name]: true } })
    expect(factory).toHaveBeenLastCalledWith(...args)
  })

  it('configures the shell tool description', async () => {
    const agent = await createHarness({ builtinTools: { shell: { description: 'Run a command in the sandbox.' } } })
    expect(agent.tools.find((t) => t.name === 'shell')?.description).toBe('Run a command in the sandbox.')
  })

  class BashSandbox extends DockerSandbox {
    override getTools(): Tool[] {
      return [makeShell(this, { name: 'sandbox_bash' }), makeFileEditor(this, { name: 'sandbox_file_editor' })]
    }
  }

  async function initializedToolNames(options: HarnessAgentOptions): Promise<string[]> {
    const agent = await createHarness(options)
    await agent.initialize()
    return toolNames(agent)
  }

  it('drops sandbox-vended tools', async () => {
    let names = await initializedToolNames({ sandbox: new DockerSandbox({ container: 'c1' }) })
    expect(names).toEqual(expect.arrayContaining(['shell', 'read', 'write', 'edit']))
    expect(names).not.toContain('sandbox_shell')
    expect(names).not.toContain('sandbox_file_editor')

    names = await initializedToolNames({ sandbox: new BashSandbox({ container: 'c1' }) })
    expect(names).not.toContain('sandbox_bash')
    expect(names).not.toContain('sandbox_file_editor')
  })

  it('disables built-in tools with an empty list', async () => {
    const agent = await createHarness({ builtinTools: [], tools: [sampleTool] })
    const names = toolNames(agent)
    expect(names).not.toContain('shell')
    expect(names).not.toContain('read')
    expect(names).toContain('sample_tool')
  })

  it('rejects an unknown built-in tool', async () => {
    await expect(createHarness({ builtinTools: ['grep'] as never })).rejects.toThrow('Unknown built-in tool')
  })

  it('does not register web_search as a tool', async () => {
    const agent = await createHarness({ model: 'openai/gpt-5.6-sol' })
    expect(toolNames(agent)).not.toContain('web_search')
  })

  it('enables web_search on a supported provider from the default set', async () => {
    const agent = await createHarness({ model: 'openai/gpt-5.6-sol' })
    const params = agent.model.getConfig().params as { tools: unknown }
    expect(params.tools).toEqual([{ type: 'web_search' }])
  })

  it('warns with the opt-in but builds when default web_search hits the default bedrock model', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const agent = await createHarness()
    expect(toolNames(agent)).not.toContain('web_search')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/has no native web search.*web_search: 'exa'/))
  })

  it('throws when web_search is explicitly selected on an unsupported provider', async () => {
    await expect(createHarness({ builtinTools: ['read', 'web_search'] })).rejects.toThrow('has no native web search')
    await expect(createHarness({ builtinTools: { web_search: true } })).rejects.toThrow('has no native web search')
  })

  it('builds the Exa tool for the fallback and warns about the third party', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const agent = await createHarness({ builtinTools: { web_search: 'exa' } })
    expect(toolNames(agent)).toContain('web_search')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Exa (exa.ai), a third-party service'))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('has no native web search'))
  })

  it('lets an explicit Exa selection win over native search', async () => {
    // https://github.com/strands-agents/harness-sdk/issues/4480
    const agent = await createHarness({
      model: 'openai/gpt-5.6-sol',
      builtinTools: { web_search: 'exa' },
    })
    expect(toolNames(agent)).toContain('web_search')
    expect(agent.model.getConfig().params).not.toHaveProperty('tools')
  })

  it('serves the Exa fallback on a Model instance', async () => {
    const agent = await createHarness({
      model: new BedrockModel({ modelId: 'x' }),
      builtinTools: { web_search: 'exa' },
    })
    expect(toolNames(agent)).toContain('web_search')
  })

  it('only offers Bedrock Web Search on GPT-5 and GPT-6 Mantle models', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    let agent = await createHarness({ model: 'bedrock-mantle/openai.gpt-5.6-luna' })
    expect(toolNames(agent)).not.toContain('web_search')
    expect((agent.model.getConfig().params as { tools: unknown }).tools).toEqual([
      { type: 'web_search', external_web_access: true },
    ])
    agent = await createHarness({ model: 'bedrock-mantle/openai.gpt-oss-120b-1:0' })
    expect(toolNames(agent)).not.toContain('web_search')
    expect(agent.model.getConfig().params).not.toHaveProperty('tools')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no native web search'))
  })

  it('enables web_search when explicitly selected on a supported provider', async () => {
    const agent = await createHarness({ model: 'google/gemini-3.5-flash', builtinTools: ['read', 'web_search'] })
    expect(agent.model.getConfig().builtInTools).toEqual([{ googleSearch: {} }])
    expect(toolNames(agent)).not.toContain('web_search')
  })

  it('enables caching by default on bedrock', async () => {
    const agent = await createHarness()
    expect(agent.model.getConfig().cacheConfig).toEqual({ strategy: 'auto' })
  })

  it('enables caching by default on anthropic direct', async () => {
    const agent = await createHarness({ model: 'anthropic/claude-opus-4-8' })
    expect(agent.model.getConfig().cacheConfig).toEqual({ strategy: 'auto' })
  })

  it('builds silently with default caching on a Model instance', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const agent = await createHarness({ model: new BedrockModel({ modelId: 'anything' }) })
    expect(agent).toBeInstanceOf(Agent)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('prompt caching not applied'))
  })

  it('warns when caching is explicitly requested on a Model instance', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const agent = await createHarness({ model: new BedrockModel({ modelId: 'anything' }), caching: true })
    expect(agent).toBeInstanceOf(Agent)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-built Model instance'))
  })

  it('warns instead of throwing when caching is explicitly enabled on a Model instance', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const instance = new BedrockModel({ modelId: 'anything' })
    const agent = await createHarness({ model: instance, caching: 'auto' })
    expect(agent.model).toBe(instance)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-built Model instance'))
  })

  it('leaves no cacheConfig when caching is disabled', async () => {
    const agent = await createHarness({ caching: false })
    expect(agent.model.getConfig().cacheConfig).toBeUndefined()
  })

  it('disables context management when falsy', async () => {
    const agent = await createHarness({ contextManager: false })
    expect(conversationManagerName(agent)).toBe('NullConversationManager')
  })

  it('uses the default strategy when contextManager is auto', async () => {
    const agent = await createHarness({ contextManager: 'auto' })
    expect(agent.contextManager).toBeInstanceOf(ContextManager)
  })

  it('disables context management when contextManager is null', async () => {
    const agent = await createHarness({ contextManager: null })
    expect(conversationManagerName(agent)).toBe('NullConversationManager')
    expect(offloaders(agent)).toHaveLength(0)
  })

  it('uses the recommended level when effort is auto', async () => {
    const agent = await createHarness({ effort: 'auto' })
    const fields = agent.model.getConfig().additionalRequestFields as { output_config: { effort: string } }
    expect(fields.output_config.effort).toBe('high')
  })

  it('sends no reasoning fields when effort is off', async () => {
    const agent = await createHarness({ effort: 'off' })
    expect(agent.model.getConfig().additionalRequestFields).toBeUndefined()
  })

  it('lets an explicit context manager win', async () => {
    const manager = new ContextManager()
    const agent = await createHarness({ contextManager: manager })
    expect(conversationManagerName(agent)).toBe('NullConversationManager')
    expect(plugins(agent)).toContain(manager)
  })

  it('wires a session manager on by default with a random id', async () => {
    const agent = await createHarness({ session: { dir: makeTempDir() } })
    const sm = agent.sessionManager as unknown as { sessionId?: string; _sessionId?: string }
    expect(sm.sessionId ?? sm._sessionId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('mints distinct ids for two default agents', async () => {
    const first = await createHarness({ session: { dir: makeTempDir() } })
    const second = await createHarness({ session: { dir: makeTempDir() } })
    expect(first.sessionId).not.toBe(second.sessionId)
    const sm = first.sessionManager as unknown as { sessionId?: string; _sessionId?: string }
    expect(first.sessionId).toBe(sm.sessionId ?? sm._sessionId)
  })

  it('builds no session manager when the session is disabled', async () => {
    const agent = await createHarness({ session: false })
    expect(agent.sessionManager).toBeUndefined()
  })

  it('passes a SessionManager instance given as session straight through', async () => {
    const supplied = new SessionManager({
      sessionId: 'mine',
      storage: { snapshot: new SessionFileStorage(makeTempDir()) },
    })
    const agent = await createHarness({ session: supplied })
    expect(agent.sessionManager).toBe(supplied)
  })

  it('prefers an explicitly supplied session manager', async () => {
    const supplied = new SessionManager({
      sessionId: 'mine',
      storage: { snapshot: new SessionFileStorage(makeTempDir()) },
    })
    const agent = await createHarness({ session: { id: 'ignored' }, sessionManager: supplied })
    expect(agent.sessionManager).toBe(supplied)
  })

  it('wires a session manager when a session id is given', async () => {
    const agent = await createHarness({ session: { id: 'user-42', dir: makeTempDir() } })
    const sm = agent.sessionManager as unknown as { sessionId?: string; _sessionId?: string }
    expect(sm.sessionId ?? sm._sessionId).toBe('user-42')
  })

  it('persists messages before the invocation finishes', async () => {
    const options = {
      session: { id: 'checkpoint', dir: makeTempDir() },
      builtinTools: [],
      builtinPlugins: [],
      contextManager: false,
      memory: false,
    } satisfies HarnessAgentOptions
    const agent = await createHarness(options)
    agent.addHook(BeforeModelCallEvent, async () => {
      const restored = await createHarness(options)
      await restored.initialize()
      expect(JSON.stringify(restored.messages)).toContain('Remember the checkpoint')
      throw new Error('Stop before calling the model')
    })
    await expect(agent.invoke('Remember the checkpoint')).rejects.toThrow('Stop before calling the model')
  })

  it('rejects an empty session id', async () => {
    await expect(createHarness({ session: { id: '' } })).rejects.toThrow('session.id must be a non-empty string.')
    await expect(createHarness({ session: { id: '   ' } })).rejects.toThrow('session.id must be a non-empty string.')
  })

  it('sanitizes the session id', async () => {
    const agent = await createHarness({
      session: { id: 'azrn:studio:us-west-2:session/abc', dir: makeTempDir() },
    })
    const sm = agent.sessionManager as unknown as { sessionId?: string; _sessionId?: string }
    expect(sm.sessionId ?? sm._sessionId).toBe('azrn-studio-us-west-2-session-abc')
  })

  it('lowercases the session id', async () => {
    const agent = await createHarness({ session: { id: 'MyProj.v2', dir: makeTempDir() } })
    const sm = agent.sessionManager as unknown as { sessionId?: string; _sessionId?: string }
    expect(sm.sessionId ?? sm._sessionId).toBe('myproj-v2')
  })

  it('uses a temp dir for offloading when the session is disabled', async () => {
    const agent = await createHarness({ session: false })
    const offs = offloaders(agent)
    expect(offs).toHaveLength(1)
    expect(offloadDir(offs[0]).startsWith(tmpdir())).toBe(true)
  })

  it('disables the offloader when context management is off', async () => {
    const agent = await createHarness({ contextManager: false })
    expect(offloaders(agent)).toHaveLength(0)
  })

  it('offloads under the session dir by default', async () => {
    const dir = makeTempDir()
    const agent = await createHarness({ session: { dir } })
    const offs = offloaders(agent)
    expect(offs).toHaveLength(1)
    expect(offloadDir(offs[0])).toBe(`${dir}/offloaded`)
  })

  it('does not double-add an offloader supplied via plugins', async () => {
    const existing = new ContextOffloader({ storage: new FileStorage({ artifactDir: makeTempDir() }) })
    const agent = await createHarness({ plugins: [existing] })
    expect(offloaders(agent)).toEqual([existing])
  })

  it('loads skills from the skills directory', async () => {
    const dir = makeTempDir()
    writeSkill(dir, 'hello')
    const agent = await createHarness({ skills: dir })
    expect(skills(agent)).toHaveLength(1)
  })

  it('passes an explicit missing skills path through to the plugin', async () => {
    const absent = join(makeTempDir(), 'absent')
    const agent = await createHarness({ skills: absent })
    const plugins = skills(agent)
    expect(plugins).toHaveLength(1)
    expect((plugins[0] as unknown as { _skillPaths: string[] })._skillPaths).toEqual([absent])
  })

  it('skips the default skills directory when it is absent', async () => {
    // Run from an empty temp dir so the check does not depend on whether this checkout has ./.agent/skills.
    const cwd = process.cwd()
    const dir = makeTempDir()
    mkdirSync(dir, { recursive: true })
    process.chdir(dir)
    try {
      const agent = await createHarness({ skills: true })
      expect(skills(agent)).toHaveLength(0)
    } finally {
      process.chdir(cwd)
    }
  })

  it('disables skills when skills is null', async () => {
    const agent = await createHarness({ skills: null })
    expect(skills(agent)).toHaveLength(0)
  })

  it('loads skills from multiple directories', async () => {
    const a = makeTempDir()
    const b = makeTempDir()
    writeSkill(a, 'hello')
    writeSkill(b, 'world')
    const agent = await createHarness({ skills: [a, b] })
    const plugins = skills(agent)
    expect(plugins).toHaveLength(1)
    expect((plugins[0] as unknown as { _skillPaths: string[] })._skillPaths).toEqual([a, b])
  })

  it('keeps missing directories when multiple are given', async () => {
    const present = makeTempDir()
    const absent = join(makeTempDir(), 'absent')
    writeSkill(present, 'hello')
    const agent = await createHarness({ skills: [present, absent] })
    const plugins = skills(agent)
    expect(plugins).toHaveLength(1)
    expect((plugins[0] as unknown as { _skillPaths: string[] })._skillPaths).toEqual([present, absent])
  })

  it('disables skills when skills is an empty array', async () => {
    const agent = await createHarness({ skills: [] })
    expect(skills(agent)).toHaveLength(0)
  })

  it('does not double-add a skills plugin supplied via plugins', async () => {
    const dir = makeTempDir()
    writeSkill(dir, 'hello')
    const existing = new AgentSkills({ skills: [dir] })
    const agent = await createHarness({ skills: dir, plugins: [existing] })
    expect(skills(agent)).toEqual([existing])
  })

  const readTool = tool({
    name: 'read',
    description: 'A consumer tool that collides with the built-in read.',
    inputSchema: z.object({ path: z.string() }),
    callback: ({ path }) => path,
  })

  const subagentTool = tool({
    name: 'subagent',
    description: 'A consumer tool that collides with the built-in subagent tool.',
    inputSchema: z.object({ task: z.string() }),
    callback: ({ task }) => task,
  })

  const todoWriteTool = tool({
    name: 'todo_write',
    description: "A consumer tool that collides with the todos plugin's built-in tool.",
    inputSchema: z.object({ todos: z.array(z.unknown()) }),
    callback: () => 'ok',
  })

  it('rejects a built-in tool colliding with a consumer tool', async () => {
    await expect(createHarness({ tools: [readTool] })).rejects.toThrow(
      /Tool name "read" is registered more than once \(from a built-in tool and tools\)\. .*drop the built-in via builtinTools \/ builtinPlugins/
    )
  })

  it('rejects a built-in plugin tool colliding with a consumer tool', async () => {
    await expect(createHarness({ builtinPlugins: ['todos'], tools: [todoWriteTool] })).rejects.toThrow(
      /Tool name "todo_write" is registered more than once \(from tools and a built-in plugin\)/
    )
  })

  it('frees a built-in plugin tool name when the plugin is dropped', async () => {
    const agent = await createHarness({ builtinPlugins: [], tools: [todoWriteTool] })
    expect(toolNames(agent)).toContain('todo_write')
  })

  it('rejects the built-in subagent tool colliding with a consumer tool', async () => {
    await expect(createHarness({ tools: [subagentTool] })).rejects.toThrow(
      /Tool name "subagent" is registered more than once \(from a built-in tool and tools\)/
    )
  })

  it('rejects a consumer tool colliding with the memory search tool', async () => {
    const searchMemoryTool = tool({
      name: 'search_memory',
      description: 'A consumer tool that collides with the memory manager tool.',
      inputSchema: z.object({ query: z.string() }),
      callback: ({ query }) => query,
    })
    await expect(createHarness({ memory: { dir: makeTempDir() }, tools: [searchMemoryTool] })).rejects.toThrow(
      /Tool name "search_memory" is registered more than once \(from tools and memory\)/
    )
  })

  it('rejects the same consumer tool listed twice', async () => {
    await expect(createHarness({ tools: [sampleTool, sampleTool] })).rejects.toThrow(
      /Tool name "sample_tool" is registered more than once \(from tools\)/
    )
  })

  it('does not mention built-ins in a consumer-only collision remedy', async () => {
    await expect(createHarness({ tools: [sampleTool, sampleTool] })).rejects.toThrow(/unique name/)
    await expect(createHarness({ tools: [sampleTool, sampleTool] })).rejects.not.toThrow(/built-in/)
  })

  it('treats a - vs _ near-collision as a collision', async () => {
    const dashFetch = tool({
      name: 'web-fetch',
      description: "Collides with web_fetch by '-' vs '_'.",
      inputSchema: z.object({ url: z.string() }),
      callback: ({ url }) => url,
    })
    await expect(createHarness({ tools: [dashFetch] })).rejects.toThrow(/registered more than once/)
  })

  it('frees the name for a consumer tool once the built-in is dropped', async () => {
    const agent = await createHarness({ builtinTools: ['shell', 'write', 'edit'], tools: [readTool] })
    expect(toolNames(agent)).toContain('read')
    const read = agent.tools.find((t) => t instanceof Tool && t.name === 'read') as Tool
    expect(read.toolSpec.description).toContain('consumer tool that collides')
  })

  it('does not name-check non-Tool entries in tools', async () => {
    // ToolList also holds Agents/McpClients/nested lists that resolve later; the collision
    // pre-flight must skip them (matching Python) rather than reach for a name they lack.
    const agent = await createHarness({ tools: [[sampleTool]] })
    expect(toolNames(agent)).toContain('sample_tool')
  })

  it('registers no interventions by default', async () => {
    const agent = await createHarness()
    expect(interventionHandlers(agent)).toEqual([])
  })

  it('wires an interventions preset', async () => {
    const agent = await createHarness({ interventions: 'ask' })
    const handlers = interventionHandlers(agent)
    expect(handlers).toHaveLength(1)
    expect(handlers[0]).toBeInstanceOf(HumanInTheLoop)
  })

  it('passes an intervention handler instance through', async () => {
    const handler = new HumanInTheLoop({ ask: 'stdio' })
    const agent = await createHarness({ interventions: handler })
    expect(interventionHandlers(agent)).toEqual([handler])
  })

  it('has a subagent delegate inherit the parent interventions and Background Tasks policy', async () => {
    const captured: HarnessAgentOptions[] = []
    const fakeFactory = async (options: HarnessAgentOptions): Promise<Agent> => {
      captured.push(options)
      return {
        appState: { set: () => undefined },
        stream: async function* () {
          yield* []
          return { stopReason: 'endTurn', interrupts: [], toString: () => 'done' }
        },
      } as unknown as Agent
    }
    const subagent = buildDefaultSubagent(fakeFactory, { interventions: 'smart', backgroundTasks: false })
    const gen = subagent.stream({
      toolUse: { name: 'subagent', toolUseId: 't1', input: { task: 'go' } },
      agent: { appState: { get: () => undefined } },
      invocationState: {},
      cancelSignal: new globalThis.AbortController().signal,
      interrupt: () => undefined,
    } as unknown as ToolContext)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    expect(captured[0]?.interventions).toBe('smart')
    expect(captured[0]?.backgroundTasks).toBe(false)
  })

  it('forwards a per-tool web_fetch config to the delegate as a pinned mapping', async () => {
    const captured: HarnessAgentOptions[] = []
    const fakeFactory = async (options: HarnessAgentOptions): Promise<Agent> => {
      captured.push(options)
      return {
        appState: { set: () => undefined },
        stream: async function* () {
          yield* []
          return { stopReason: 'endTurn', interrupts: [], toString: () => 'done' }
        },
      } as unknown as Agent
    }
    const subagent = buildDefaultSubagent(fakeFactory, {
      builtinTools: { web_fetch: { model: 'openai/gpt-5-mini' }, shell: { description: 'Run it.' } },
    })
    const gen = subagent.stream({
      toolUse: { name: 'subagent', toolUseId: 't1', input: { task: 'go', tools: ['web_fetch', 'read', 'shell'] } },
      agent: { appState: { get: () => undefined } },
      invocationState: {},
      cancelSignal: new globalThis.AbortController().signal,
      interrupt: () => undefined,
    } as unknown as ToolContext)
    let next = await gen.next()
    while (!next.done) {
      next = await gen.next()
    }
    // Every name is pinned except web_search, which the parent left to the defaults.
    expect(captured[0]?.builtinTools).toEqual({
      shell: { description: 'Run it.' },
      read: true,
      write: false,
      edit: false,
      web_fetch: { model: 'openai/gpt-5-mini' },
      programmatic_tool_caller: false,
      subagent: false,
    })
  })

  it('loads MCP servers through the SDK, resilient and prefixed by server name', async () => {
    // The SDK owns file reading, `mcpServers` unwrapping, and the per-server defaults; the harness only
    // passes the config through.
    const loadServers = vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])
    await createHarness({ mcpServers: '~/mcp.json' })
    expect(loadServers).toHaveBeenCalledWith('~/mcp.json', { continueOnError: true }, { prefixWithServerName: true })
    loadServers.mockRestore()
  })

  it('does not touch MCP when no servers are given', async () => {
    const loadServers = vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])
    await createHarness()
    expect(loadServers).not.toHaveBeenCalled()
    loadServers.mockRestore()
  })
})

describe('subagent delegate (built child)', () => {
  // Build a real delegate through the default builder — the SubagentTool holds it as `builder` — and
  // assert the guarantees on the constructed child, mirroring the Python child tests.
  function buildChildFrom(parent: Agent, spec: AgentSpec): Promise<Agent> {
    const subagentTool = parent.tools.find((t) => t.name === 'subagent') as unknown as {
      builder: (spec: AgentSpec) => Promise<Agent>
    }
    return subagentTool.builder(spec)
  }

  async function buildChild(options: HarnessAgentOptions, spec: AgentSpec): Promise<Agent> {
    return buildChildFrom(await createHarness(options), spec)
  }

  it('narrows the built child to the requested subset, dropping the rest', async () => {
    const spec = new AgentSpec('x')
    spec.tools = ['read']
    const child = await buildChild({ builtinTools: ['read', 'shell', 'subagent'] }, spec)
    expect(toolNames(child)).toContain('read')
    expect(toolNames(child)).not.toContain('shell')
  })

  it('hands the built child every consumer tool when the model does not narrow', async () => {
    const child = await buildChild({ tools: [sampleTool] }, new AgentSpec('x'))
    expect(toolNames(child)).toContain('sample_tool')
  })

  it('gives the built child a recall-only (non-writable) memory view', async () => {
    const child = await buildChild({ memory: { dir: makeTempDir() } }, new AgentSpec('x'))
    expect(child.memoryManager).toBeInstanceOf(MemoryManager)
    expect(storeOf(child.memoryManager as MemoryManager).writable).toBe(false)
  })

  it('builds the child with sessions forced off', async () => {
    const child = await buildChild({ session: { dir: makeTempDir() } }, new AgentSpec('x'))
    expect(child.sessionManager).toBeUndefined()
  })

  it('registers the inherited interventions gate on the built child', async () => {
    const child = await buildChild({ interventions: 'ask' }, new AgentSpec('x'))
    expect(interventionHandlers(child)).toHaveLength(1)
    expect(interventionHandlers(child)[0]).toBeInstanceOf(HumanInTheLoop)
  })

  it('keeps its own subagent tool so a delegate can sub-delegate', async () => {
    const child = await buildChild({}, new AgentSpec('x'))
    expect(toolNames(child)).toContain('subagent')
  })

  it('carries explicit web_search onto a narrowed delegate', async () => {
    // web_search is never in the tools enum; a narrowed selection drops it, but the builder carries
    // the parent's setting onto the delegate, which resolves it for its own model.
    const spec = new AgentSpec('x')
    spec.tools = ['read']
    const child = await buildChild(
      { model: 'openai/gpt-5.6-sol', builtinTools: ['read', 'web_search', 'subagent'] },
      spec
    )
    expect((child.model.getConfig().params as { tools: unknown }).tools).toEqual([{ type: 'web_search' }])
  })

  it('keeps native search on a narrowed delegate of a default-configured parent', async () => {
    const spec = new AgentSpec('x')
    spec.tools = ['read']
    const child = await buildChild({ model: 'openai/gpt-5.6-sol' }, spec)
    expect((child.model.getConfig().params as { tools: unknown }).tools).toEqual([{ type: 'web_search' }])
  })

  it('carries the Exa fallback onto a narrowed delegate', async () => {
    const spec = new AgentSpec('x')
    spec.tools = ['read']
    const child = await buildChild({ builtinTools: { web_search: 'exa' } }, spec)
    expect(toolNames(child)).toContain('web_search')
  })

  it('inherits the parent MCP tools via the shared clients, narrowable per server', async () => {
    // A delegate shares the parent's connected MCP clients, keyed by server name; an omitted
    // mcp_servers selection grants every server, an empty one drops them, a named one grants it.
    const server = fileURLToPath(new URL('./tools/echo-mcp-server.mjs', import.meta.url))
    const parent = await createHarness({ mcpServers: { srv: { command: 'node', args: [server] } } })
    try {
      await parent.initialize()
      expect(toolNames(parent)).toContain('srv_echo')

      const inheritAll = await buildChildFrom(parent, new AgentSpec('x'))
      await inheritAll.initialize()
      expect(toolNames(inheritAll)).toContain('srv_echo')

      const none = new AgentSpec('x')
      none.mcpServers = []
      const narrowed = await buildChildFrom(parent, none)
      await narrowed.initialize()
      expect(toolNames(narrowed)).not.toContain('srv_echo')

      const one = new AgentSpec('x')
      one.mcpServers = ['srv', 'srv'] // a repeated name (array-of-enum axis) must not forward a client twice
      const selected = await buildChildFrom(parent, one)
      await selected.initialize()
      expect(toolNames(selected)).toContain('srv_echo')

      // The parent's servers become the mcp_servers enum on the delegation tool's schema.
      const subagentTool = parent.tools.find((t) => t.name === 'subagent')!
      const schema = subagentTool.toolSpec.inputSchema as { properties: { mcp_servers: { items: { enum: string[] } } } }
      expect(schema.properties.mcp_servers.items.enum).toEqual(['srv'])
    } finally {
      const clients = (parent as unknown as { _mcpClients: McpClient[] })._mcpClients
      await Promise.all(clients.map((client) => client.disconnect()))
    }
  })

  it('offers MCP clients passed in `tools` on the mcp_servers axis', async () => {
    // Connected clients handed in via `tools` (how the CLI passes servers) are offered to delegates too,
    // each under its own clientName.
    const server = fileURLToPath(new URL('./tools/echo-mcp-server.mjs', import.meta.url))
    const clients = await McpClient.loadServers(
      { alpha: { command: 'node', args: [server] }, beta: { command: 'node', args: [server] } },
      undefined,
      { prefixWithServerName: true }
    )
    const parent = await createHarness({ tools: clients })
    try {
      await parent.initialize()
      expect(toolNames(parent)).toEqual(expect.arrayContaining(['alpha_echo', 'beta_echo']))
      const subagentTool = parent.tools.find((t) => t.name === 'subagent')!
      const schema = subagentTool.toolSpec.inputSchema as { properties: { mcp_servers: { items: { enum: string[] } } } }
      expect(schema.properties.mcp_servers.items.enum).toEqual(['alpha', 'beta'])
      const toolsAxis = (subagentTool.toolSpec.inputSchema as { properties: { tools: { items: { enum: string[] } } } })
        .properties.tools.items.enum
      expect(toolsAxis).not.toEqual(expect.arrayContaining(['alpha'])) // servers never pose as tools

      // Narrowing both axes at once: the tools split must not drop the selected servers.
      const spec = new AgentSpec('x')
      spec.tools = ['read']
      spec.mcpServers = ['beta']
      const child = await buildChildFrom(parent, spec)
      await child.initialize()
      expect(toolNames(child)).toEqual(expect.arrayContaining(['read', 'beta_echo']))
      expect(toolNames(child)).not.toContain('alpha_echo')
    } finally {
      await Promise.all(clients.map((client) => client.disconnect()))
    }
  })

  it('warns when two MCP clients share a clientName and offers only the first', async () => {
    // Two clients answering to the same clientName can't both sit behind one enum value: the first is
    // offered, the second is dropped from delegation, and the collapse is warned about.
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const server = fileURLToPath(new URL('./tools/echo-mcp-server.mjs', import.meta.url))
    const clients = await McpClient.loadServers(
      { alpha: { command: 'node', args: [server] }, beta: { command: 'node', args: [server] } },
      { applicationName: 'shared' }, // a shared default name overrides the per-key naming
      { prefixWithServerName: true }
    )
    const parent = await createHarness({ tools: clients })
    try {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('share the name "shared"'))
      await parent.initialize()
      expect(toolNames(parent)).toEqual(expect.arrayContaining(['alpha_echo', 'beta_echo'])) // the parent keeps both
      const subagentTool = parent.tools.find((t) => t.name === 'subagent')!
      const schema = subagentTool.toolSpec.inputSchema as { properties: { mcp_servers: { items: { enum: string[] } } } }
      expect(schema.properties.mcp_servers.items.enum).toEqual(['shared'])
      const spec = new AgentSpec('x')
      spec.mcpServers = ['shared']
      const child = await buildChildFrom(parent, spec)
      await child.initialize()
      expect(toolNames(child)).toContain('alpha_echo')
      expect(toolNames(child)).not.toContain('beta_echo')
    } finally {
      await Promise.all(clients.map((client) => client.disconnect()))
    }
  })

  it('warns about an MCP client without applicationName and leaves it off the mcp_servers axis', async () => {
    // A hand-built client has no name the model could pick, so it stays out of the axis (and out of
    // delegates) with a warning telling the caller how to fix it.
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const server = fileURLToPath(new URL('./tools/echo-mcp-server.mjs', import.meta.url))
    const bare = new McpClient({
      transport: new StdioClientTransport({ command: 'node', args: [server] }),
      prefix: 'bare',
    })
    const parent = await createHarness({ tools: [bare] })
    try {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('has no applicationName'))
      await parent.initialize()
      expect(toolNames(parent)).toContain('bare_echo')
      const subagentTool = parent.tools.find((t) => t.name === 'subagent')!
      const schema = subagentTool.toolSpec.inputSchema as { properties: Record<string, unknown> }
      expect(schema.properties).not.toHaveProperty('mcp_servers') // no offerable server, so no axis at all
      const child = await buildChildFrom(parent, new AgentSpec('x'))
      await child.initialize()
      expect(toolNames(child)).not.toContain('bare_echo')
    } finally {
      await bare.disconnect()
    }
  })

  it('forwards inherited MCP servers to a grandchild', async () => {
    // A delegate of a delegate keeps the parent's MCP tools: the child forwards its shared clients on.
    const server = fileURLToPath(new URL('./tools/echo-mcp-server.mjs', import.meta.url))
    const parent = await createHarness({ mcpServers: { srv: { command: 'node', args: [server] } } })
    try {
      await parent.initialize()
      const child = await buildChildFrom(parent, new AgentSpec('x'))
      await child.initialize()
      expect(toolNames(child)).toContain('srv_echo')

      const grandchild = await buildChildFrom(child, new AgentSpec('x'))
      await grandchild.initialize()
      expect(toolNames(grandchild)).toContain('srv_echo')
    } finally {
      const clients = (parent as unknown as { _mcpClients: McpClient[] })._mcpClients
      await Promise.all(clients.map((client) => client.disconnect()))
    }
  })

  it('propagates MCP narrowing through a grandchild', async () => {
    // A child restricted to no MCP servers can't pass any to a grandchild; a granted server carries on.
    const server = fileURLToPath(new URL('./tools/echo-mcp-server.mjs', import.meta.url))
    const parent = await createHarness({ mcpServers: { srv: { command: 'node', args: [server] } } })
    try {
      await parent.initialize()

      const starvedSpec = new AgentSpec('x')
      starvedSpec.mcpServers = []
      const starved = await buildChildFrom(parent, starvedSpec)
      await starved.initialize()
      expect(toolNames(starved)).not.toContain('srv_echo')
      const starvedGrandchild = await buildChildFrom(starved, new AgentSpec('x'))
      await starvedGrandchild.initialize()
      expect(toolNames(starvedGrandchild)).not.toContain('srv_echo')

      const grantedSpec = new AgentSpec('x')
      grantedSpec.mcpServers = ['srv']
      const granted = await buildChildFrom(parent, grantedSpec)
      await granted.initialize()
      const grantedGrandchild = await buildChildFrom(granted, new AgentSpec('x'))
      await grantedGrandchild.initialize()
      expect(toolNames(grantedGrandchild)).toContain('srv_echo')
    } finally {
      const clients = (parent as unknown as { _mcpClients: McpClient[] })._mcpClients
      await Promise.all(clients.map((client) => client.disconnect()))
    }
  })
})

describe('subagent selectable set', () => {
  it('keeps subagent (for sub-delegation) and drops web_search (resolved per model, not selected)', async () => {
    const agent = await createHarness()
    const subagentTool = agent.tools.find((t) => t.name === 'subagent')!
    const enumValues = (subagentTool.toolSpec.inputSchema as { properties: { tools: { items: { enum: string[] } } } })
      .properties.tools.items.enum as string[]
    expect(enumValues).toContain('subagent')
    expect(enumValues).not.toContain('web_search')
  })
})
