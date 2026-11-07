import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'
import {
  Message,
  TextBlock,
  ToolResultBlock,
  Agent,
  FileStorage,
  MemoryManager,
  SessionManager,
  type AgentResult,
  type BeforeModelCallEvent,
  type FunctionTool,
  type LocalAgent,
  type Tool,
  type ToolContext,
  type ToolStreamEvent,
} from '@strands-agents/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'
import { AgentSkills, type Skill } from '@strands-agents/sdk/vended-plugins/skills'

const mocks = vi.hoisted(() => ({
  createHarness: vi.fn(),
  loadMcp: vi.fn(),
  resolveInterventions: vi.fn(),
  exportAgentProject: vi.fn(),
}))

vi.mock('@strands-agents/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@strands-agents/harness')>()),
  createHarness: mocks.createHarness,
  resolveInterventions: mocks.resolveInterventions,
}))
vi.mock('../../src/project/export.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/project/export.js')>()),
  exportAgentProject: mocks.exportAgentProject,
}))
vi.mock('../../src/agent/mcp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agent/mcp.js')>()),
  loadMcp: mocks.loadMcp,
}))

import { createInteractiveChat as createInteractiveChatRuntime } from '../../src/ui/chat/runtime.js'
import { createInteractiveRuntime, interactiveBackgroundTasks } from '../../src/agent/runtime.js'
import { CliConfigStore } from '../../src/config/store.js'
import { sessionId, SessionRootCatalog } from '../../src/session/sessions.js'
import { StrandsChatBackend } from '../../src/agent/backend.js'
import { LiveSteering } from '../../src/agent/messaging.js'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import * as providerDiscovery from '../../src/model/discovery.js'
import * as projectWatch from '../../src/project/watch.js'
import { parse, stringify } from 'smol-toml'

import { writeSessionWithSavedSystemPrompt } from '../fixtures/saved-system-prompt.js'

let testSessionRoot = ''

function createInteractiveChat(
  options: Parameters<typeof createInteractiveChatRuntime>[0] = {},
  conversations?: Parameters<typeof createInteractiveChatRuntime>[1],
  conversationId?: string
): ReturnType<typeof createInteractiveChatRuntime> {
  return createInteractiveChatRuntime(
    {
      ...options,
      ...(!options.config && !options.configPath ? { config: CliConfigStore.memory() } : {}),
      sessionRoot: options.sessionRoot ?? testSessionRoot,
    },
    conversations,
    conversationId
  )
}

beforeEach(() => {
  testSessionRoot = join(tmpdir(), `strands-runtime-test-${process.pid}-${randomUUID()}`, 'sessions')
  mocks.createHarness.mockReset()
  mocks.resolveInterventions.mockReset()
  mocks.resolveInterventions.mockImplementation(async (value) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  )
  mocks.loadMcp.mockReset()
  mocks.exportAgentProject.mockReset()
  mocks.exportAgentProject.mockResolvedValue('/tmp/strands-export.zip')
  mocks.loadMcp.mockResolvedValue({
    clients: [],
    dispose: vi.fn(async () => {}),
    warnings: [],
  })
})

afterEach(async () => {
  await rm(dirname(testSessionRoot), { recursive: true, force: true })
})

describe('interactiveBackgroundTasks', () => {
  it('uses detached mode so background work does not hold the composer', () => {
    expect(interactiveBackgroundTasks({})).toEqual({ waitForCompletion: false })
    expect(interactiveBackgroundTasks({ backgroundTasks: true })).toEqual({ waitForCompletion: false })
  })

  it('preserves custom policy and disables background waiting for interactive use', () => {
    const configured = { always: ['read'], maxConcurrency: 2, waitForCompletion: true }
    expect(interactiveBackgroundTasks({ backgroundTasks: configured })).toEqual({
      always: ['read'],
      maxConcurrency: 2,
      waitForCompletion: false,
    })
    expect(configured.waitForCompletion).toBe(true)
    expect(interactiveBackgroundTasks({ backgroundTasks: { never: ['*'] } })).toEqual({
      never: ['*'],
      waitForCompletion: false,
    })
    expect(interactiveBackgroundTasks({ backgroundTasks: false })).toBe(false)
  })
})

describe('interactive runtime lifecycle', () => {
  it('builds the agent from the profile when the resumed session saved its own agent definition', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'strands-runtime-definition-'))
    await writeSessionWithSavedSystemPrompt(join(workspace, '.agent', 'sessions'), 'saved-session')
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old'))
    const controller = await createInteractiveChat({
      cwd: workspace,
      agentOptions: { session: { id: 'saved-session' } },
    })
    try {
      expect(mocks.createHarness).toHaveBeenCalledWith(
        expect.objectContaining({ session: expect.objectContaining({ id: 'saved-session' }) })
      )
      expect(mocks.createHarness.mock.calls[0]?.[0]).not.toHaveProperty('instructions')
    } finally {
      await controller.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('owns a backend without a controller and forbids in-process reconstruction when disabled', async () => {
    const flush = vi.fn(async () => {})
    const agent = fakeAgent('anthropic.claude-old', 'single-generation', { flush })
    const mcpDispose = vi.fn(async () => {})
    mocks.createHarness.mockResolvedValue(agent)
    mocks.loadMcp.mockResolvedValue({ clients: [], warnings: [], dispose: mcpDispose })
    const owner = await createInteractiveRuntime({
      config: CliConfigStore.memory(),
      sessionRoot: testSessionRoot,
      agentOptions: { model: 'bedrock/anthropic.claude-old', session: false },
      allowRebuild: false,
      configurationEnabled: true,
    })
    const request = {
      workspace: dirname(testSessionRoot),
      sessionDirectory: testSessionRoot,
      peerEndpointId: 'agent-1',
    }
    const owned = await owner.createBackend(request)
    try {
      expect(owned.backend.agent).toBe(agent)
      expect(owned.configuration).toBeDefined()
      expect(owned.runtime.sessionId).toBeUndefined()
      await expect(owned.runtime.prepareRestart('bedrock/anthropic.claude-old')).resolves.toMatchObject({
        model: 'bedrock/anthropic.claude-old',
        preserveConversation: true,
        preserveReasoning: true,
      })
      await expect(owned.backend.restartModel('bedrock/anthropic.claude-old')).rejects.toThrow(
        'This runtime cannot rebuild the agent.'
      )
      await expect(owned.backend.clear()).rejects.toThrow('This runtime cannot rebuild the agent.')
      await expect(owned.backend.setEffort('medium')).rejects.toThrow('This runtime cannot rebuild the agent.')
      expect(mocks.createHarness).toHaveBeenCalledOnce()
    } finally {
      await Promise.all([owner.dispose(), owned.backend.dispose(), owned.mcp.dispose()])
    }
    expect(agent.cancel).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(mcpDispose).toHaveBeenCalledOnce()
    await expect(owner.createBackend(request)).rejects.toThrow('Runtime is disposed.')
  })

  it('loads the saved name when starting with an explicit session ID', async () => {
    const sessionDirectory = join(dirname(testSessionRoot), 'named-sessions')
    await mkdir(join(sessionDirectory, 'saved-one'), { recursive: true })
    await writeFile(
      join(sessionDirectory, 'saved-one', 'cli-session.json'),
      JSON.stringify({ version: 1, name: 'Release planning' })
    )
    const agent = fakeAgent('old')
    Object.assign(agent, { sessionManager: { sessionId: 'saved-one' } })
    mocks.createHarness.mockResolvedValueOnce(agent)
    const controller = await createInteractiveChat({
      agentOptions: { model: 'bedrock/old', session: { id: 'Saved.One', dir: sessionDirectory } },
    })
    try {
      expect(controller.getSnapshot().runtime).toMatchObject({
        session: 'Release planning',
        sessionName: 'Release planning',
      })
      expect(controller.backend.info?.().sessionId).toBe('saved-one')
      await controller.submit('/rename Shipping')
      expect(JSON.parse(await readFile(join(sessionDirectory, 'saved-one', 'cli-session.json'), 'utf8'))).toEqual({
        version: 1,
        name: 'Shipping',
      })
      expect(await readdir(sessionDirectory)).toEqual(['saved-one'])
      const switchModel = vi.spyOn(controller.backend, 'switchModel')
      await controller.submit('/model bedrock/old')
      expect(switchModel).toHaveBeenCalledWith('bedrock/old')
      expect(controller.getSnapshot().runtime).toMatchObject({ session: 'Shipping', sessionName: 'Shipping' })
    } finally {
      await controller.dispose()
    }
  })

  it('applies an explicit context offload threshold to preset context management', async () => {
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old'))
    const controller = await createInteractiveChat({
      config: CliConfigStore.memory({}, { contextOffloadThreshold: 2_500 }),
    })

    try {
      const contextManager = mocks.createHarness.mock.calls[0]?.[0].contextManager as {
        strategies: readonly { _threshold?: number; _utilizationThreshold?: number }[]
      }
      expect(contextManager.strategies).toMatchObject([{ _threshold: 2_500 }, { _utilizationThreshold: 0.85 }])
    } finally {
      await controller.dispose()
    }
  })

  it('loads authored MCP servers through the CLI runtime', async () => {
    const servers = { authored: { command: 'node', args: ['./server.mjs'] } }
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old'))
    const controller = await createInteractiveChat({
      agentOptions: { session: false, mcpServers: servers },
    })

    try {
      expect(mocks.loadMcp).toHaveBeenCalledWith(expect.objectContaining({ servers }))
      expect(mocks.createHarness).toHaveBeenCalledWith(expect.not.objectContaining({ mcpServers: expect.anything() }))
    } finally {
      await controller.dispose()
    }
  })

  it('exports the displayed draft and its skills without applying it to the running agent', async () => {
    const projectExport =
      await vi.importActual<typeof import('../../src/project/export.js')>('../../src/project/export.js')
    mocks.exportAgentProject.mockImplementation(projectExport.exportAgentProject)
    const root = dirname(testSessionRoot)
    await mkdir(join(root, 'skills', 'review'), { recursive: true })
    await writeFile(join(root, 'skills', 'review', 'SKILL.md'), '# Review')
    const profile = defineHarnessAgentConfig({
      instructions: 'Original instructions.',
      skills: false,
      model: 'bedrock/anthropic.claude-old',
    })
    const config = CliConfigStore.memory({}, {}, { profile, profileBaseDir: root })
    const agent = fakeAgent('old')
    mocks.createHarness.mockResolvedValueOnce(agent)
    const requestSetup = vi.fn()
    const controller = await createInteractiveChat({
      config,
      agentProfile: profile,
      agentOptions: { model: profile.model, skills: false, backgroundTasks: false },
      requestSetup,
    })
    try {
      const configuration = mocks.createHarness.mock.calls[0]?.[0].tools.find(
        (candidate: Tool) => candidate.name === 'strands_config'
      )
      agent.stream = async function* () {
        yield* []
        await configuration.invoke(
          { action: 'update', profile: { instructions: 'Draft instructions.', skills: ['./skills'] } },
          { agent }
        )
        return { stopReason: 'endTurn' } as AgentResult
      }
      await controller.submit('Draft new instructions and add the review skill.')
      await controller.submit('/config')

      for (const language of ['typescript', 'python'] as const) {
        const preview = controller.getSnapshot().configuration!.documents[language]
        expect(preview.error).toBeUndefined()
        expect(preview.source).toContain('Draft instructions.')
        const destination = join(root, `${language}.zip`)
        await controller.submit(`/export ${language} "${destination}"`)
        const entries = unzipSync(await readFile(destination))
        const entrypoint = language === 'python' ? 'agent/agent.py' : 'agent/agent.ts'

        expect(Buffer.from(entries[entrypoint]!).toString()).toBe(preview.source)
        expect(entries).toHaveProperty('agent/skills/review/SKILL.md')
      }
      expect(config.snapshot().profile.instructions).toBe('Original instructions.')
      expect(requestSetup).not.toHaveBeenCalled()
      expect(mocks.createHarness).toHaveBeenCalledOnce()
    } finally {
      await controller.dispose()
    }
  })

  it.each(['writable', 'read-only', 'unrecognized'])(
    'keeps %s memory private during export and reload',
    async (kind) => {
      const { createHarness } =
        await vi.importActual<typeof import('@strands-agents/harness')>('@strands-agents/harness')
      mocks.createHarness.mockImplementation(createHarness)
      const root = dirname(testSessionRoot)
      await mkdir(root, { recursive: true })
      const entrypoint = join(root, 'agent.ts')
      await writeFile(entrypoint, 'export const marker = "source"\n')
      const store =
        kind === 'unrecognized'
          ? new TestMemoryStore({
              name: 'personal',
              path: join(root, 'private-data.json'),
              extraction: false,
            })
          : new FileMemoryStore({
              name: 'personal',
              storage: new LocalFileStorage(join(root, 'private-data')),
              writable: kind === 'writable',
              extraction: false,
            })
      await store.add('Private memory sentinel')
      const requestSetup = vi.fn()
      const watch = vi.spyOn(projectWatch, 'watchAgentProject').mockReturnValue(() => {})
      const controller = await createInteractiveChat({
        cwd: root,
        project: { root, entrypoint, language: 'typescript' },
        requestSetup,
        agentOptions: {
          model: new BedrockModel({ modelId: 'anthropic.claude-test' }),
          session: false,
          memory: new MemoryManager({ stores: [store] }),
          skills: false,
          builtinTools: [],
          builtinPlugins: [],
          contextManager: false,
          backgroundTasks: false,
          caching: false,
          effort: 'off',
        },
      })
      try {
        await store.add('Another private memory')
        if (kind === 'unrecognized') {
          expect(watch).not.toHaveBeenCalled()
          expect(await readFile(join(root, 'private-data.json'), 'utf8')).toContain('Private memory sentinel')
          const refused = join(root, 'unsafe.zip')
          await controller.submit(`/export typescript "${refused}"`)
          await expect(readFile(refused)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(JSON.stringify(controller.getSnapshot())).toContain('Cannot safely export this agent')
          return
        }
        expect(watch.mock.calls[0]?.[3]).toContain(join(root, 'private-data', 'memory', 'personal'))

        const destination = join(root, 'agent.zip')
        await controller.submit(`/export typescript "${destination}"`)
        const entries = unzipSync(await readFile(destination))
        expect(Object.keys(entries).some((path) => path.endsWith('.md'))).toBe(false)
        expect(Buffer.from(entries['agent.ts']!).toString()).toContain('source')

        const storage: unknown = Reflect.get(store, '_storage')
        Reflect.deleteProperty(store, '_storage')
        try {
          const refused = join(root, 'unsafe.zip')
          await controller.submit(`/export typescript "${refused}"`)
          await expect(readFile(refused)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(JSON.stringify(controller.getSnapshot())).toContain('Cannot safely export this agent')
        } finally {
          Reflect.set(store, '_storage', storage)
        }
      } finally {
        await controller.dispose()
        watch.mockRestore()
      }
    }
  )

  it.each([
    'legacy session',
    'unified session',
    'inherited session',
    'namespaced session',
    'explicit stash',
    'inherited stash',
    'namespaced stash',
  ])('keeps %s storage private during export and reload', async (kind) => {
    const { createHarness } = await vi.importActual<typeof import('@strands-agents/harness')>('@strands-agents/harness')
    let agent!: Agent
    mocks.createHarness.mockImplementation(async (options) => {
      agent = await createHarness(options)
      return agent
    })
    const root = dirname(testSessionRoot)
    await mkdir(root, { recursive: true })
    const entrypoint = join(root, 'agent.ts')
    await writeFile(entrypoint, 'export const marker = "source"\n')
    await writeFile(join(root, 'public.txt'), 'Public project file')
    const storage = new LocalFileStorage(root)
    const stash = kind.endsWith('stash')
    const sessionStorage =
      kind === 'legacy session'
        ? { snapshot: new FileStorage(join(root, 'private-state')) }
        : kind === 'namespaced session'
          ? storage.namespace('private-state')
          : storage
    const requestSetup = vi.fn()
    const watch = vi.spyOn(projectWatch, 'watchAgentProject').mockReturnValue(() => {})
    const controller = await createInteractiveChat({
      cwd: root,
      project: { root, entrypoint, language: 'typescript' },
      requestSetup,
      agentOptions: {
        model: new BedrockModel({ modelId: 'anthropic.claude-test' }),
        session: false,
        ...(!stash
          ? {
              sessionManager: new SessionManager({
                sessionId: 'private-session',
                ...(kind !== 'inherited session' ? { storage: sessionStorage } : {}),
              }),
            }
          : {}),
        ...(kind.startsWith('inherited') ? { storage } : {}),
        contextManager: stash
          ? {
              strategies: [],
              ...(kind !== 'inherited stash'
                ? { stash: { storage: kind === 'namespaced stash' ? storage.namespace('private-state') : storage } }
                : {}),
            }
          : false,
        memory: false,
        skills: false,
        builtinTools: [],
        builtinPlugins: [],
        backgroundTasks: false,
        caching: false,
        effort: 'off',
      },
    })
    const persist = async (text: string): Promise<void> => {
      if (stash) {
        await agent.contextManager!.stash!.store('private-entry', 0, Buffer.from(text))
      } else {
        agent.messages.push(Message.fromJSON({ role: 'user', content: [{ text }] }))
        await agent.sessionManager!.saveSnapshot({ target: agent, isLatest: true })
      }
    }
    try {
      await persist('Private storage sentinel')
      const privateDirectory = stash
        ? kind === 'namespaced stash'
          ? 'private-state'
          : 'context'
        : kind === 'legacy session' || kind === 'namespaced session'
          ? 'private-state'
          : 'session'
      expect(watch.mock.calls[0]?.[3]).toContain(join(root, privateDirectory))
      expect(watch.mock.calls[0]?.[3]).not.toContain(root)

      const destination = join(root, 'agent.zip')
      await controller.submit(`/export typescript "${destination}"`)
      const entries = unzipSync(await readFile(destination))
      expect(Buffer.from(entries['agent.ts']!).toString()).toContain('source')
      expect(Buffer.from(entries['public.txt']!).toString()).toBe('Public project file')
      expect(Object.keys(entries).some((path) => path.startsWith(privateDirectory.replaceAll('\\', '/') + '/'))).toBe(
        false
      )
      expect(Object.values(entries).some((bytes) => Buffer.from(bytes).includes('storage sentinel'))).toBe(false)
      const owner = stash ? agent.contextManager!.stash! : agent.sessionManager!
      const field = stash ? '_storage' : '_configStorage'
      const value: unknown = Reflect.get(owner, field)
      Reflect.deleteProperty(owner, field)
      try {
        const refused = join(root, 'unsafe.zip')
        await controller.submit(`/export typescript "${refused}"`)
        await expect(readFile(refused)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(JSON.stringify(controller.getSnapshot())).toContain('Cannot safely export this agent')
      } finally {
        Reflect.set(owner, field, value)
      }
    } finally {
      await controller.dispose()
      watch.mockRestore()
    }
  })

  it('exports the current conversation model and effort when persistence is disabled', async () => {
    const modelDiscovery = vi.spyOn(providerDiscovery, 'discoverProviderModels').mockResolvedValue({
      available: true,
      models: [{ id: 'anthropic.claude-new', name: 'New model' }],
    })
    const profile = defineHarnessAgentConfig({ name: 'Portable', model: 'bedrock/anthropic.claude-old' })
    mocks.createHarness
      .mockResolvedValueOnce(fakeAgent('old'))
      .mockResolvedValueOnce(fakeAgent('new'))
      .mockResolvedValueOnce(fakeAgent('new', 'fork'))
    const controller = await createInteractiveChat({
      agentProfile: profile,
      agentOptions: { model: profile.model },
      persistModelChanges: false,
    })
    try {
      await controller.backend.restartModel?.('bedrock/anthropic.claude-new')
      await controller.backend.setEffort?.('high')
      await controller.submit('/export')
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows.find((row) => row.label === 'TypeScript')!)
      await controller.activatePanelRow({
        label: 'Continue',
        description: 'portable',
        value: 'export:name:typescript:portable',
      })
      await controller.activatePanelRow(
        controller.getSnapshot().panel!.rows.find((row) => row.label === 'Default folder')!
      )

      expect(mocks.exportAgentProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Portable', model: 'bedrock/anthropic.claude-new', effort: 'high' }),
        'typescript',
        expect.any(Array),
        process.cwd(),
        expect.stringMatching(/[/\\]\.strands[/\\]harnesses[/\\]portable$/u),
        'directory'
      )
      expect(controller.getSnapshot().panel?.title).toBe('Export complete')
      controller.dismissPanel()
      await controller.submit('/fork')
      await controller.submit('/export')
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows.find((row) => row.label === 'TypeScript')!)
      await controller.activatePanelRow({
        label: 'Continue',
        description: 'portable',
        value: 'export:name:typescript:portable',
      })
      await controller.activatePanelRow(
        controller.getSnapshot().panel!.rows.find((row) => row.label === 'Default folder')!
      )
      expect(mocks.exportAgentProject).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Portable', model: 'bedrock/anthropic.claude-new', effort: 'high' }),
        'typescript',
        expect.any(Array),
        process.cwd(),
        expect.stringMatching(/[/\\]\.strands[/\\]harnesses[/\\]portable$/u),
        'directory'
      )
    } finally {
      modelDiscovery.mockRestore()
      await controller.dispose()
    }
  })

  it('loads and persists presentation settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-settings-'))
    const configPath = join(directory, 'cli.toml')
    await writeFile(configPath, stringify({ settings: { showReasoning: false } }))
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old'))
    const controller = await createInteractiveChat({ configPath })

    try {
      expect(controller.getSnapshot().settings).toMatchObject({
        animations: true,
        showReasoning: false,
      })
      await controller.submit('/settings')
      const animations = controller.getSnapshot().panel?.rows.find((row) => row.value === 'animations')
      expect(animations).toBeDefined()
      await controller.activatePanelRow(animations!)

      expect(parse(await readFile(configPath, 'utf8')).settings).toMatchObject({
        animations: false,
        showReasoning: false,
      })
    } finally {
      await controller.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { configured: 'saved', selected: 'team' },
    { configured: undefined, selected: 'shell' },
  ])('routes AWS profile $selected through the conversation-preserving reload', async ({ configured, selected }) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-profiles-'))
    const awsConfig = join(directory, 'config')
    await writeFile(awsConfig, '[profile shell]\nregion=us-east-1\n[profile team]\nregion=us-west-2\n')
    vi.stubEnv('AWS_PROFILE', 'shell')
    vi.stubEnv('AWS_CONFIG_FILE', awsConfig)
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(directory, 'credentials'))
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'fixture-token')
    const config = CliConfigStore.memory({}, {}, { providerEnvironment: configured ? { AWS_PROFILE: configured } : {} })
    const requestSetup = vi.fn()
    const modelDiscovery = vi.spyOn(providerDiscovery, 'discoverProviderModels').mockResolvedValue({
      available: true,
      models: [{ id: 'anthropic.claude-old', name: 'Current model' }],
    })
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old'))
    const runtimeProfile = { ...config.snapshot().profile, model: 'bedrock/cli-override', name: 'From flags' }
    const controller = await createInteractiveChat({
      config,
      requestSetup,
      agentProfile: runtimeProfile,
      agentOptions: { model: runtimeProfile.model },
      persistModelChanges: false,
    })
    try {
      await controller.openModelPanel()
      expect(controller.getSnapshot().panel).toMatchObject({
        kind: 'models',
        awsProfile: {
          value: configured ?? '',
          options: [
            { value: '', label: 'Environment/default' },
            { value: 'shell', label: 'shell' },
            { value: 'team', label: 'team' },
            ...(configured ? [{ value: configured, label: configured }] : []),
          ],
        },
      })
      await controller.activatePanelRow({
        label: 'AWS profile',
        description: '',
        value: 'aws-profile:toggle',
      })
      await controller.activatePanelRow({
        label: selected,
        description: '',
        value: `aws-profile:select:${selected}`,
      })
      expect(requestSetup).toHaveBeenCalledExactlyOnceWith({
        configuration: expect.objectContaining({
          profile: config.snapshot().profile,
          providerEnvironment: { AWS_PROFILE: selected },
        }),
        profile: runtimeProfile,
        conversationId: 'agent-1',
      })
      expect(config.configuredProviderEnvironment().AWS_PROFILE).toBe(configured)
      expect(process.env.AWS_PROFILE).toBe('shell')
      expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('fixture-token')
    } finally {
      await controller.dispose()
      modelDiscovery.mockRestore()
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('loads persistent permission settings into the Strands backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-config-'))
    const configPath = join(directory, 'cli.toml')
    await writeFile(configPath, stringify({ permissions: { mode: 'bypassPermissions', allow: ['bash'] } }))
    const agent = fakeAgent('old')
    Object.assign(agent, {
      tools: [
        { name: 'bash', description: 'Run commands' } as Tool,
        { name: 'write', description: 'Write files' } as Tool,
      ],
    })
    mocks.createHarness.mockResolvedValueOnce(agent)
    const controller = await createInteractiveChat({ configPath })

    try {
      await controller.submit('/permissions')
      expect(controller.getSnapshot()).toMatchObject({
        panel: {
          kind: 'permissions',
          searchable: true,
          slider: {
            options: [
              { id: 'ask', label: 'Ask' },
              { id: 'bypass', label: 'Bypass', active: true },
              { id: 'custom', label: 'Custom' },
            ],
          },
          rows: [
            { label: 'bash', control: { kind: 'toggle', checked: true } },
            { label: 'write', control: { kind: 'toggle', checked: true } },
          ],
        },
      })
      const writePermission = controller.getSnapshot().panel?.rows.find((row) => row.label === 'write')
      expect(writePermission).toBeDefined()
      expect(writePermission?.value).toBeUndefined()
      await controller.activatePanelRow({
        label: 'Permission mode',
        description: 'Custom',
        value: 'permissions:preset:custom',
      })
      const configurableWritePermission = controller.getSnapshot().panel?.rows.find((row) => row.label === 'write')
      expect(configurableWritePermission?.value).toBeDefined()
      await controller.activatePanelRow(configurableWritePermission!)
      expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
        permissions: { allow: ['bash', 'write'] },
      })
    } finally {
      await controller.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['close', 'clear', 'restart'])('persists memory through %s and repeated disposal', async (operation) => {
    const flush = vi.fn(async () => {})
    const nextFlush = vi.fn(async () => {})
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old', 'agent-old', { flush }))
    mocks.createHarness.mockImplementationOnce(async () => {
      expect(flush).toHaveBeenCalledOnce()
      return fakeAgent('old', 'agent-next', { flush: nextFlush })
    })
    const controller = await createInteractiveChat({ agentOptions: { model: 'bedrock/old' } })

    if (operation === 'clear') await controller.submit('/clear')
    if (operation === 'restart') await controller.backend.restartModel?.('bedrock/old')
    await controller.dispose()
    await controller.dispose()
    expect(mocks.createHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ id: expect.stringMatching(/^\d{8}t\d{6}z-[0-9a-f]{8}$/) }),
      })
    )
    expect(flush).toHaveBeenCalledOnce()
    expect(nextFlush).toHaveBeenCalledTimes(operation === 'close' ? 0 : 1)
  })

  it.each(['construction', 'initialization'])('cleans a fork that finishes %s after disposal', async (stage) => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const flush = vi.fn(async () => {})
    const late = fakeAgent('old', 'late-fork', { flush })
    const wait = async (): Promise<void> => {
      started()
      await gate
    }
    if (stage === 'initialization') vi.mocked(late.initialize).mockImplementation(wait)
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old')).mockImplementationOnce(async () => {
      if (stage === 'construction') await wait()
      return late
    })
    const mcpDispose = vi.fn(async () => {})
    mocks.loadMcp.mockResolvedValue({ clients: [], warnings: [], dispose: mcpDispose })
    const controller = await createInteractiveChat({ agentOptions: { session: false } })
    const forking = controller.submit('/fork')
    try {
      await ready
      controller.close()
      await controller.dispose()
      release()
      await forking
      expect(late.cancel).toHaveBeenCalledOnce()
      expect(flush).toHaveBeenCalledOnce()
      expect(mcpDispose).toHaveBeenCalledTimes(2)
      expect(controller.getSnapshot().status).toBe('closed')
    } finally {
      release()
      await forking
      await controller.dispose()
    }
  })

  it('cleans a constructed agent when initialization fails and preserves the initialization error', async () => {
    const failure = new Error('Authored initialization failed')
    const flush = vi.fn().mockRejectedValue(new Error('Memory unavailable'))
    const agent = fakeAgent('old', 'failed-init', { flush })
    vi.mocked(agent.initialize).mockRejectedValue(failure)
    mocks.createHarness.mockResolvedValue(agent)
    const mcpDispose = vi.fn(async () => {})
    mocks.loadMcp.mockResolvedValue({ clients: [], warnings: [], dispose: mcpDispose })

    await expect(createInteractiveChat({ agentOptions: { session: false } })).rejects.toBe(failure)
    expect(agent.cancel).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(mcpDispose).toHaveBeenCalledOnce()
  })

  it('keeps the active agent usable when its memory flush rejects a restart', async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error('Memory store unavailable')).mockResolvedValue(undefined)
    const agent = fakeAgent('old', 'agent-old', { flush })
    const stream = vi.spyOn(agent, 'stream')
    mocks.createHarness.mockResolvedValueOnce(agent)
    const controller = await createInteractiveChat({ agentOptions: { model: 'bedrock/old' } })

    try {
      await expect(controller.backend.restartModel?.('bedrock/old')).rejects.toThrow('Memory store unavailable')
      expect(mocks.createHarness).toHaveBeenCalledOnce()
      expect((controller.backend as StrandsChatBackend).agent).toBe(agent)
      await controller.submit('Continue with the current agent.')
      expect(stream).toHaveBeenCalledOnce()
    } finally {
      await controller.dispose()
    }
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it.each(['in-memory', 'managed'])('keeps %s sessions without a CLI file ID through clear', async (label) => {
    const sessionManager = { sessionId: 'managed-session' } as NonNullable<Agent['sessionManager']>
    mocks.createHarness.mockImplementation(async () =>
      Object.assign(fakeAgent('old'), label === 'managed' ? { sessionManager } : {})
    )
    const sessionOptions = label === 'managed' ? { sessionManager } : { session: false as const }
    const controller = await createInteractiveChat({ agentOptions: { model: 'bedrock/old', ...sessionOptions } })

    try {
      expect(mocks.createHarness.mock.calls[0]?.[0]).toMatchObject(sessionOptions)
      expect(controller.getSnapshot().runtime).toMatchObject({ session: label })
      await controller.submit('/clear')
      const builds = label === 'managed' ? 1 : 2
      expect(mocks.createHarness).toHaveBeenCalledTimes(builds)
      expect(mocks.createHarness.mock.calls[builds - 1]?.[0]).toMatchObject(sessionOptions)
      expect(controller.getSnapshot().runtime).toMatchObject({ session: label })
      expect(controller.backend.info?.().sessionId).toBeUndefined()
      expect(controller.resumeSession).toBeUndefined()
      expect(sessionManager.sessionId).toBe('managed-session')
      if (label === 'managed') {
        expect(controller.getSnapshot().panel).toMatchObject({
          kind: 'error',
          title: 'clear failed',
          rows: [{ description: expect.stringContaining('custom session manager owns this session') }],
        })
      }
    } finally {
      await controller.dispose()
    }
  })

  it('clarifies legacy Desktop agent identity before restoring the transcript', async () => {
    const agent = fakeAgent('old')
    agent.messages = [
      new Message({
        role: 'user',
        content: [
          new TextBlock(
            [
              '<strands_agent_profile>',
              'Name: John',
              'Job: Another tester',
              'Operating brief: Helpful agent who speaks like Tony Stark',
              'Keep this role for the entire durable session. Do not repeat this profile unless the user asks.',
              '</strands_agent_profile>',
              '',
              'hey can you hear me',
            ].join('\n')
          ),
        ],
      }),
      new Message({
        role: 'assistant',
        content: [new TextBlock('Loud and clear.')],
      }),
    ]
    mocks.createHarness.mockResolvedValueOnce(agent)
    const controller = await createInteractiveChat()

    try {
      expect(agent.messages[0]?.content[0]).toMatchObject({
        type: 'textBlock',
        text: expect.stringContaining(
          'The following fields describe you, the assistant. They do not describe the user.'
        ),
      })
      expect(controller.getSnapshot().completedTurns[0]?.prompt).toBe('hey can you hear me')
    } finally {
      await controller.dispose()
    }
  })

  it('forks the active configuration and cloned message history into a new agent', async () => {
    const firstAgent = fakeAgent('old', 'first')
    const forkAgent = fakeAgent('old', 'fork')
    const saveForkSnapshot = vi.fn(async () => {})
    ;(forkAgent as unknown as { sessionManager: { saveSnapshot: typeof saveForkSnapshot } }).sessionManager = {
      saveSnapshot: saveForkSnapshot,
    }
    const configuredSessionManager = {} as NonNullable<Agent['sessionManager']>
    const clonedMessage = {
      role: 'user',
      content: [{ type: 'textBlock', text: 'Remember the parser constraints.' }],
      clone: vi.fn(),
    }
    clonedMessage.clone.mockImplementation(() => ({
      role: clonedMessage.role,
      content: clonedMessage.content.map((block) => ({ ...block })),
      clone: clonedMessage.clone,
    }))
    firstAgent.messages = [clonedMessage] as unknown as Agent['messages']
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(forkAgent)
    const controller = await createInteractiveChat({
      agentOptions: {
        model: 'bedrock/anthropic.claude-old',
        effort: 'low',
        session: { id: 'saved-one' },
        sessionManager: configuredSessionManager,
      },
    })

    try {
      await controller.submit('/fork')

      expect(mocks.createHarness.mock.calls[0]?.[0].sessionManager).toBe(configuredSessionManager)
      expect(mocks.createHarness).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          model: 'bedrock/anthropic.claude-old',
          effort: 'low',
        })
      )
      expect(sessionId(mocks.createHarness.mock.calls[1]![0])).toMatch(/^\d{8}t\d{6}z-[0-9a-f]{8}$/)
      expect(mocks.createHarness.mock.calls[1]?.[0]).not.toHaveProperty('sessionManager')
      expect(forkAgent.messages).toHaveLength(1)
      expect(forkAgent.messages[0]).not.toBe(clonedMessage)
      expect(saveForkSnapshot).toHaveBeenCalledWith({ target: forkAgent, isLatest: true })
      expect(controller.backend).toBeInstanceOf(StrandsChatBackend)
      expect((controller.backend as StrandsChatBackend).agent).toBe(forkAgent)
    } finally {
      await controller.dispose()
    }
  })

  it('does not expose a fork when its initial snapshot cannot be saved', async () => {
    const firstAgent = fakeAgent('old', 'first')
    const flush = vi.fn(async () => {})
    const forkAgent = fakeAgent('old', 'fork', { flush })
    const saveSnapshot = vi.fn(async () => Promise.reject(new Error('fork snapshot failed')))
    ;(forkAgent as unknown as { sessionManager: { saveSnapshot: typeof saveSnapshot } }).sessionManager = {
      saveSnapshot,
    }
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(forkAgent)
    const controller = await createInteractiveChat()

    try {
      await controller.submit('/fork')

      expect(controller.getSnapshot().panel).toMatchObject({
        kind: 'error',
        title: 'fork failed',
        rows: [{ description: 'fork snapshot failed' }],
      })
      expect((controller.backend as StrandsChatBackend).agent).toBe(firstAgent)
      expect(forkAgent.cancel).toHaveBeenCalledOnce()
      expect(flush).toHaveBeenCalledOnce()
    } finally {
      await controller.dispose()
    }
  })

  it('carries the latest measured context into an unchanged fork', async () => {
    const firstAgent = fakeAgent('old', 'first')
    const forkAgent = fakeAgent('old', 'fork')
    configureMeasuredTurn(firstAgent)
    configureMeasuredTurn(forkAgent)
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(forkAgent)
    const controller = await createInteractiveChat({
      agentOptions: {
        model: 'bedrock/anthropic.claude-old',
        effort: 'off',
      },
    })

    try {
      await controller.submit('measure context')
      const expected = {
        currentTokens: 100,
        projectedTokens: 125,
        contextWindow: 1_000,
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      }
      expect(controller.getSnapshot().context).toEqual(expected)

      await controller.submit('/fork')

      expect(mocks.createHarness).toHaveBeenNthCalledWith(2, expect.objectContaining({ effort: 'off' }))
      expect(controller.getSnapshot().context).toEqual(expected)
    } finally {
      await controller.dispose()
    }
  })

  it.each([true, false])(
    'honors peer messaging in new and forked agents while MCP discovery is off (%s)',
    async (enabled) => {
      const firstAgent = fakeAgent('old', 'first')
      const forkAgent = fakeAgent('old', 'fork')
      mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(forkAgent)
      const controller = await createInteractiveChat({
        config: CliConfigStore.memory({}, { agentMessaging: enabled, mcpDiscovery: false }),
        agentOptions: { skills: false },
      })

      try {
        await controller.submit('/fork')
        const mainPlugin = mocks.createHarness.mock.calls[0]?.[0].plugins?.find(
          (candidate: { name?: string }) => candidate.name === 'strands:agent-messaging'
        )
        const forkPlugin = mocks.createHarness.mock.calls[1]?.[0].plugins?.find(
          (candidate: { name?: string }) => candidate.name === 'strands:agent-messaging'
        )
        expect(mocks.loadMcp).toHaveBeenCalledWith(expect.objectContaining({ paths: [] }))
        if (!enabled) {
          expect(mainPlugin).toBeUndefined()
          expect(forkPlugin).toBeUndefined()
          return
        }
        expect(mainPlugin).toBeDefined()
        expect(forkPlugin).toBeDefined()
        await mainPlugin!.initAgent(firstAgent)
        await forkPlugin!.initAgent(forkAgent)
        const messageAgent = mainPlugin!.getTools?.()[0] as FunctionTool

        expect(messageAgent.name).toBe('message_agent')
        await expect(
          messageAgent.invoke({ action: 'list' }, { agent: firstAgent } as unknown as ToolContext)
        ).resolves.toEqual({
          agents: [{ id: 'agent-2', name: 'Fork 2', status: 'idle' }],
        })
      } finally {
        await controller.dispose()
      }
    }
  )

  it.each([['a'.repeat(79) + '👩‍💻tail', 'a'.repeat(79) + '👩‍💻']])(
    'exposes a live background subagent as a temporary task-addressed message endpoint (%s)',
    async (task, summary) => {
      let steering!: LiveSteering
      let child!: LocalAgent
      const subagent = fakeSubagent(
        () => steering,
        (agent) => {
          child = agent
        }
      )
      const parent = fakeAgent('old', 'first')
      parent.toolRegistry.get = vi.fn((name: string) => (name === 'subagent' ? subagent : undefined))
      exposeBackgroundTask(parent)
      mocks.createHarness.mockResolvedValueOnce(parent)
      const controller = await createInteractiveChat()

      try {
        steering = mocks.createHarness.mock.calls[0]?.[0].interventions?.find(
          (candidate: unknown) => candidate instanceof LiveSteering
        ) as LiveSteering
        const plugin = mocks.createHarness.mock.calls[0]?.[0].plugins?.find(
          (candidate: { name?: string }) => candidate.name === 'strands:agent-messaging'
        )
        expect(steering).toBeInstanceOf(LiveSteering)
        expect(plugin).toBeDefined()
        await plugin!.initAgent(parent)
        const messageAgent = plugin!.getTools?.()[0] as FunctionTool
        const stream = subagent.stream(backgroundToolContext(parent, task))

        await stream.next()
        await expect(
          messageAgent.invoke({ action: 'list' }, { agent: parent } as unknown as ToolContext)
        ).resolves.toEqual({
          agents: [{ id: 'task-1', name: `subagent: ${summary}`, status: 'working' }],
        })
        await controller.submit('/agents')
        expect(controller.getSnapshot().panel).toMatchObject({
          kind: 'agents',
          title: 'Agents',
          rows: [
            expect.objectContaining({
              label: 'Strands harness',
              description: 'Primary agent',
              current: true,
              badge: { text: 'idle', tone: 'success' },
            }),
            expect.objectContaining({
              label: `subagent: ${summary}`,
              current: false,
              badge: { text: 'working', tone: 'success' },
            }),
          ],
        })
        await messageAgent.invoke({ action: 'send', to: 'task-1', message: 'Check the authorization tests.' }, {
          agent: parent,
        } as unknown as ToolContext)
        applySteering(steering, child)
        expect(child.messages).toMatchObject([
          {
            role: 'user',
            content: [
              { type: 'textBlock', text: 'Message from Strands harness (agent-1):\n\nCheck the authorization tests.' },
            ],
          },
        ])

        await stream.next()
        await vi.waitFor(() => expect(controller.getSnapshot().panel?.title).toBe('Agents'))
        await expect(
          messageAgent.invoke({ action: 'list' }, { agent: parent } as unknown as ToolContext)
        ).resolves.toEqual({
          agents: [],
        })
      } finally {
        await controller.dispose()
      }
    }
  )

  it('isolates identical background task IDs across forked conversations', async () => {
    let mainSteering!: LiveSteering
    let forkSteering!: LiveSteering
    let mainChild!: LocalAgent
    let forkChild!: LocalAgent
    const mainSubagent = fakeSubagent(
      () => mainSteering,
      (child) => {
        mainChild = child
      }
    )
    const forkSubagent = fakeSubagent(
      () => forkSteering,
      (child) => {
        forkChild = child
      }
    )
    const mainAgent = fakeAgent('old', 'main')
    const forkAgent = fakeAgent('old', 'fork')
    mainAgent.toolRegistry.get = vi.fn((name: string) => (name === 'subagent' ? mainSubagent : undefined))
    forkAgent.toolRegistry.get = vi.fn((name: string) => (name === 'subagent' ? forkSubagent : undefined))
    exposeBackgroundTask(mainAgent)
    exposeBackgroundTask(forkAgent)
    mocks.createHarness.mockResolvedValueOnce(mainAgent).mockResolvedValueOnce(forkAgent)
    const controller = await createInteractiveChat()

    try {
      await controller.submit('/fork')
      mainSteering = mocks.createHarness.mock.calls[0]?.[0].interventions?.find(
        (candidate: unknown) => candidate instanceof LiveSteering
      ) as LiveSteering
      forkSteering = mocks.createHarness.mock.calls[1]?.[0].interventions?.find(
        (candidate: unknown) => candidate instanceof LiveSteering
      ) as LiveSteering
      const mainPlugin = mocks.createHarness.mock.calls[0]?.[0].plugins?.find(
        (candidate: { name?: string }) => candidate.name === 'strands:agent-messaging'
      )
      expect(mainPlugin).toBeDefined()
      await mainPlugin!.initAgent(mainAgent)
      const messageAgent = mainPlugin!.getTools?.()[0] as FunctionTool
      const mainStream = mainSubagent.stream(backgroundToolContext(mainAgent, 'Review main authentication.'))
      const forkStream = forkSubagent.stream(backgroundToolContext(forkAgent, 'Review fork authentication.'))

      await mainStream.next()
      await forkStream.next()
      const listed = (await messageAgent.invoke({ action: 'list' }, {
        agent: mainAgent,
      } as unknown as ToolContext)) as {
        agents: { id: string; name: string }[]
      }
      const mainEndpoint = listed.agents.find((agent) => agent.name.includes('Review main authentication.'))
      const forkEndpoint = listed.agents.find((agent) => agent.name.includes('Review fork authentication.'))
      expect(mainEndpoint?.id).toBe('task-1')
      expect(forkEndpoint?.id).toBe('task-2')

      await messageAgent.invoke({ action: 'send', to: mainEndpoint!.id, message: 'Check the main task.' }, {
        agent: mainAgent,
      } as unknown as ToolContext)
      await messageAgent.invoke({ action: 'send', to: forkEndpoint!.id, message: 'Check the fork task.' }, {
        agent: mainAgent,
      } as unknown as ToolContext)
      applySteering(mainSteering, mainChild)
      applySteering(forkSteering, forkChild)

      expect(mainChild.messages).toMatchObject([
        {
          role: 'user',
          content: [{ type: 'textBlock', text: 'Message from Strands harness (agent-1):\n\nCheck the main task.' }],
        },
      ])
      expect(forkChild.messages).toMatchObject([
        {
          role: 'user',
          content: [{ type: 'textBlock', text: 'Message from Strands harness (agent-1):\n\nCheck the fork task.' }],
        },
      ])

      await mainStream.next()
      await forkStream.next()
    } finally {
      await controller.dispose()
    }
  })

  it('keeps conversation messages and state when setup changes the agent configuration', async () => {
    const firstAgent = new Agent({
      name: 'Before',
      model: new BedrockModel({ modelId: 'old' }),
      systemPrompt: 'Original instructions',
      messages: [
        Message.fromJSON({ role: 'user', content: [{ text: 'Remember the blue frog.' }] }),
        Message.fromJSON({
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 'call', name: 'read', input: { path: 'notes' } } }],
        }),
        Message.fromJSON({
          role: 'user',
          content: [{ toolResult: { toolUseId: 'call', status: 'success', content: [{ text: 'Blue frog' }] } }],
        }),
        Message.fromJSON({ role: 'assistant', content: [{ text: 'Remembered.' }] }),
      ],
    })
    firstAgent.appState.set('notes', 'Blue frog')
    const replacement = new Agent({
      name: 'After',
      model: new BedrockModel({ modelId: 'new' }),
      systemPrompt: 'Updated instructions',
    })
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(replacement)
    const previous = await createInteractiveChat({ agentOptions: { model: 'bedrock/old' } })
    const conversations = await previous.captureConversations()
    const current = await createInteractiveChat(
      {
        agentOptions: { name: 'After', model: 'bedrock/new', instructions: 'Updated instructions', builtinTools: [] },
      },
      conversations
    )
    try {
      expect(replacement.messages).toEqual(firstAgent.messages)
      expect(replacement.appState.get('notes')).toBe('Blue frog')
      expect(replacement.systemPrompt).toBe('Updated instructions')
      expect(replacement.model.modelId).toBe('new')
      expect(current.getSnapshot().runtime.agent).toBe('After')
      expect(current.getSnapshot().completedTurns).toEqual(previous.getSnapshot().completedTurns)
      expect(mocks.createHarness).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: 'bedrock/new',
          instructions: 'Updated instructions',
          builtinTools: [],
        })
      )
    } finally {
      await Promise.all([previous.dispose(), current.dispose()])
    }
  })

  it('restores every conversation with stable IDs and applies setup to its initiating chat', async () => {
    const model = 'bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0'
    const replacementModel = 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0'
    const workspace = dirname(testSessionRoot)
    const agents: Agent[] = []
    mocks.createHarness.mockImplementation(async (options) => {
      const agent = new Agent({ model: new BedrockModel({ modelId: options.model.slice('bedrock/'.length) }) })
      agents.push(agent)
      return agent
    })
    const previous = await createInteractiveChat({
      cwd: workspace,
      agentOptions: { model, effort: 'low', session: { dir: testSessionRoot } },
    })
    let current: Awaited<ReturnType<typeof createInteractiveChat>> | undefined
    try {
      mocks.createHarness.mockRejectedValueOnce(new Error('Fork startup failed'))
      await previous.submit('/fork')
      previous.dismissPanel()
      await previous.submit('/fork')
      await previous.backend.setEffort?.('high')
      agents[0]!.messages.push(Message.fromJSON({ role: 'user', content: [{ text: 'Primary state' }] }))
      agents[1]!.messages.push(Message.fromJSON({ role: 'user', content: [{ text: 'Fork state' }] }))
      agents[0]!.appState.set('owner', 'primary')
      agents[1]!.appState.set('owner', 'fork')
      const captured = await previous.captureConversations()
      expect(captured.activeId).toBe('agent-3')
      expect(captured.entries.map(({ id }) => id)).toEqual(['agent-1', 'agent-3'])
      const options = {
        cwd: workspace,
        agentOptions: { model: replacementModel, effort: 'low' as const, session: { dir: testSessionRoot } },
      }
      current = await createInteractiveChat(options, captured, 'agent-1')
      const restored = await current.captureConversations()
      expect(restored.activeId).toBe(captured.activeId)
      expect(restored.entries.map(({ id, title, description }) => ({ id, title, description }))).toEqual(
        captured.entries.map(({ id, title, description }) => ({ id, title, description }))
      )
      expect(restored.entries.map(({ conversation }) => conversation.session)).toEqual(
        captured.entries.map(({ conversation }) => conversation.session)
      )
      expect(restored.entries.map(({ conversation }) => conversation.selection)).toEqual([
        { model: replacementModel, thinking: 'low' },
        { model, thinking: 'high' },
      ])
      expect(agents[2]!.messages).toEqual(agents[0]!.messages)
      expect(agents[3]!.messages).toEqual(agents[1]!.messages)
      expect(agents[2]!.appState.get('owner')).toBe('primary')
      expect(agents[3]!.appState.get('owner')).toBe('fork')
      await current.submit('/fork')
      expect((await current.captureConversations()).activeId).toBe('agent-4')
    } finally {
      await Promise.all([previous.dispose(), current?.dispose()])
    }
  })

  it('disposes partial replacement resources without changing the original roster', async () => {
    const model = 'bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0'
    const agents = [0, 1, 2].map(() => new Agent({ model: new BedrockModel({ modelId: model }) }))
    mocks.createHarness
      .mockResolvedValueOnce(agents[0])
      .mockResolvedValueOnce(agents[1])
      .mockResolvedValueOnce(agents[2])
      .mockRejectedValueOnce(new Error('Second replacement failed'))
    const originalDispose = vi.fn(async () => {})
    const replacementDispose = vi.fn(async () => {})
    mocks.loadMcp
      .mockResolvedValueOnce({ clients: [], warnings: [], dispose: originalDispose })
      .mockResolvedValueOnce({ clients: [], warnings: [], dispose: originalDispose })
      .mockResolvedValue({ clients: [], warnings: [], dispose: replacementDispose })
    const options = { agentOptions: { model, session: false as const } }
    const original = await createInteractiveChat(options)
    try {
      await original.submit('/fork')
      const captured = await original.captureConversations()
      await expect(createInteractiveChat(options, captured)).rejects.toThrow('Second replacement failed')
      expect(replacementDispose).toHaveBeenCalledTimes(2)
      expect(originalDispose).not.toHaveBeenCalled()
      expect(await original.captureConversations()).toMatchObject({
        activeId: captured.activeId,
        entries: captured.entries.map(({ id, title }) => ({ id, title })),
      })
    } finally {
      await original.dispose()
    }
  })

  it.each(['error', 'cancelled'] as const)(
    'reports an unapplied configuration after a %s turn and requires an explicit retry',
    async (status) => {
      const discovery = vi.spyOn(providerDiscovery, 'discoverProviderModels').mockResolvedValue({
        available: true,
        models: [{ id: 'anthropic.claude-new', name: 'New model' }],
      })
      const first = fakeAgent('old', 'first')
      const replacement = fakeAgent('new', 'replacement')
      const saveSnapshot = vi.fn(async () => {})
      Object.assign(replacement, { sessionManager: { saveSnapshot } })
      mocks.createHarness.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
      const requestSetup = vi.fn()
      const controller = await createInteractiveChat({
        requestSetup,
        agentOptions: { model: 'bedrock/anthropic.claude-old', backgroundTasks: false },
      })
      try {
        await controller.backend.restartModel?.('bedrock/anthropic.claude-new')
        const configuration = mocks.createHarness.mock.calls[1]?.[0].tools.find(
          (candidate: Tool) => candidate.name === 'strands_config'
        )
        const invoke = (input: Record<string, unknown>): Promise<unknown> =>
          configuration.invoke(input, { agent: replacement })
        let finishTurn: (() => void) | undefined
        replacement.stream = async function* () {
          yield* []
          await invoke({ action: 'update', profile: { name: 'Changed' } })
          await invoke({ action: 'apply', revision: 1 })
          if (status === 'error') throw new Error('Provider disconnected')
          await new Promise<void>((resolve) => {
            finishTurn = resolve
          })
          return { stopReason: 'endTurn' } as AgentResult
        }
        const submitting = controller.submit('Change my name')
        if (status === 'cancelled') {
          await vi.waitFor(() => expect(finishTurn).toBeDefined())
          controller.cancel()
          finishTurn!()
        }
        await submitting
        expect(controller.getSnapshot().completedTurns.at(-1)?.status).toBe(status)
        expect(controller.getSnapshot().panel).toMatchObject({
          title: 'Setup not applied',
          rows: [{ description: expect.stringContaining('configuration was not applied') }],
        })
        expect(replacement.messages.at(-1)?.toJSON()).toMatchObject({
          content: [{ text: expect.stringContaining('The turn did not complete') }],
        })
        expect(first.messages).toHaveLength(0)
        expect(saveSnapshot).toHaveBeenCalledWith({ target: replacement, isLatest: true })
        expect(requestSetup).not.toHaveBeenCalled()
        replacement.stream = async function* () {
          yield* []
          return { stopReason: 'endTurn' } as AgentResult
        }
        await controller.submit('Unrelated message')
        expect(requestSetup).not.toHaveBeenCalled()
        replacement.stream = async function* () {
          yield* []
          await invoke({ action: 'apply', revision: 1 })
          return { stopReason: 'endTurn' } as AgentResult
        }
        await controller.submit('Apply the draft again')
        expect(requestSetup).toHaveBeenCalledOnce()
        expect(requestSetup).toHaveBeenCalledWith(
          expect.objectContaining({
            profile: expect.objectContaining({ name: 'Changed' }),
          })
        )
      } finally {
        discovery.mockRestore()
        await controller.dispose()
      }
    }
  )

  it('applies a queued model effort on the next prompt while preserving conversation messages', async () => {
    const firstAgent = fakeAgent('old', 'first')
    const replacementAgent = fakeAgent('old', 'replacement')
    firstAgent.messages = [
      new Message({
        role: 'user',
        content: [new TextBlock('Keep this context.')],
      }),
    ]
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(replacementAgent)
    const controller = await createInteractiveChat({
      agentOptions: { model: 'bedrock/anthropic.claude-old', effort: 'medium' },
    })

    try {
      await controller.backend.setEffort?.('high')

      expect(mocks.createHarness).toHaveBeenCalledTimes(1)
      expect((controller.backend as StrandsChatBackend).info()).toMatchObject({ effort: 'High' })

      await controller.submit('Use the new effort.')

      expect(mocks.createHarness).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          model: 'bedrock/anthropic.claude-old',
          effort: 'high',
        })
      )
      expect(replacementAgent.messages).toHaveLength(1)
    } finally {
      await controller.dispose()
    }
  })

  it('uses the workspace-relative session directory and preserves the original conversation on resume', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'strands-runtime-session-'))
    const relativeSessionDirectory = join('state', 'sessions')
    const sessionDirectory = resolve(workspace, relativeSessionDirectory)
    const sessionRoot = join(workspace, 'config', 'sessions')
    await mkdir(join(sessionDirectory, 'saved-one'), { recursive: true })
    await writeFile(
      join(sessionDirectory, 'saved-one', 'cli-session.json'),
      JSON.stringify({ version: 1, name: 'Release planning' })
    )
    const firstAgent = fakeAgent('old')
    const resumedAgent = fakeAgent('old')
    const saveResumedSnapshot = vi.fn(async () => {})
    ;(resumedAgent as unknown as { sessionManager: { saveSnapshot: typeof saveResumedSnapshot } }).sessionManager = {
      saveSnapshot: saveResumedSnapshot,
    }
    configureMeasuredTurn(firstAgent)
    const configuredSessionManager = {} as NonNullable<Agent['sessionManager']>
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(resumedAgent)
    const controller = await createInteractiveChat({
      cwd: workspace,
      agentOptions: {
        model: 'bedrock/anthropic.claude-old',
        session: { dir: relativeSessionDirectory },
        sessionManager: configuredSessionManager,
      },
      sessionRoot,
    })

    try {
      expect(mocks.createHarness).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          model: 'bedrock/anthropic.claude-old',
          session: { dir: sessionDirectory },
          sessionManager: configuredSessionManager,
        })
      )

      await controller.submit('measure context')
      expect(controller.getSnapshot().context.projectedTokens).toBe(125)
      await controller.submit('/sessions')
      expect(controller.getSnapshot().panel).toMatchObject({
        kind: 'sessions',
        rows: [{ label: 'Release planning', value: 'saved-one' }],
      })
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

      expect(mocks.createHarness).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          model: 'bedrock/anthropic.claude-old',
          session: { dir: sessionDirectory, id: 'saved-one' },
        })
      )
      expect(mocks.createHarness.mock.calls[1]?.[0]).not.toHaveProperty('sessionManager')
      expect(saveResumedSnapshot).not.toHaveBeenCalled()
      expect(controller.getSnapshot().runtime).toMatchObject({
        cwd: workspace,
        session: 'Release planning',
        sessionName: 'Release planning',
      })
      expect(controller.getSnapshot().context).toEqual({})
    } finally {
      await controller.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('restores context stored with a compatible saved-session transcript', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'strands-runtime-session-context-'))
    const sessionDirectory = resolve(workspace, 'state', 'sessions')
    const sessionRoot = join(workspace, 'config', 'sessions')
    await mkdir(join(sessionDirectory, 'saved-one'), { recursive: true })
    const firstAgent = fakeAgent('old')
    const resumedAgent = fakeAgent('old')
    configureMeasuredTurn(firstAgent)
    configureMeasuredTurn(resumedAgent)
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(resumedAgent)
    const controller = await createInteractiveChat({
      cwd: workspace,
      agentOptions: {
        model: 'bedrock/anthropic.claude-old',
        session: { dir: join('state', 'sessions') },
        sessionManager: {} as NonNullable<Agent['sessionManager']>,
      },
      sessionRoot,
    })

    try {
      await controller.submit('measure context')
      resumedAgent.messages = firstAgent.messages.map((message) => message.clone())

      await controller.submit('/sessions')
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

      expect(controller.getSnapshot().context).toEqual({
        currentTokens: 100,
        projectedTokens: 125,
        contextWindow: 1_000,
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      })
    } finally {
      await controller.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('opens cross-workspace sessions with workspace-bound resources and keeps the source conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-cross-workspace-'))
    const firstWorkspace = join(directory, 'first')
    const secondWorkspace = join(directory, 'second')
    const explicitMcp = join(directory, '.claude.json')
    const sessionRoot = join(directory, 'config', 'sessions')
    const firstSessions = join(firstWorkspace, '.agent', 'sessions')
    const secondSessions = join(secondWorkspace, '.agent', 'sessions')
    await mkdir(join(secondWorkspace, '.agent', 'skills', 'remote'), { recursive: true })
    await writeFile(
      join(secondWorkspace, '.agent', 'skills', 'remote', 'SKILL.md'),
      '---\nname: remote\ndescription: Remote workspace skill\n---\nRemote instructions.'
    )
    await mkdir(join(secondSessions, 'saved-two'), { recursive: true })
    const catalog = await SessionRootCatalog.load(sessionRoot)
    await catalog.register(secondSessions, secondWorkspace)
    mocks.createHarness
      .mockResolvedValueOnce(fakeAgent('old', 'first-agent'))
      .mockResolvedValueOnce(fakeAgent('old', 'second-agent'))
    const firstMcp = {
      clients: [],
      paths: [],
      list: vi.fn(async () => []),
      dispose: vi.fn(async () => {}),
      warnings: [],
    }
    const secondMcp = {
      clients: [],
      paths: [],
      list: vi.fn(async () => []),
      dispose: vi.fn(async () => {}),
      warnings: [],
    }
    mocks.loadMcp.mockResolvedValueOnce(firstMcp).mockResolvedValueOnce(secondMcp)
    const controller = await createInteractiveChat({
      cwd: firstWorkspace,
      agentOptions: { model: 'bedrock/anthropic.claude-old', session: { dir: firstSessions } },
      mcpPaths: [explicitMcp],
      mcpStrictPaths: [explicitMcp],
      sessionRoot,
    })
    let disposed = false

    try {
      await controller.submit('keep the first workspace alive')
      await controller.submit('/sessions')
      const remoteIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.label === 'saved-two')
      expect(remoteIndex).toBeGreaterThanOrEqual(0)
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows[remoteIndex!]!)

      const secondOptions = mocks.createHarness.mock.calls[1]![0]
      expect(secondOptions).toEqual(
        expect.objectContaining({
          model: 'bedrock/anthropic.claude-old',
          session: { dir: secondSessions, id: 'saved-two' },
          skills: expect.any(AgentSkills),
        })
      )
      const sandbox = secondOptions.sandbox
      expect(sandbox && sandbox !== false).toBe(true)
      const realSecondWorkspace = await realpath(secondWorkspace)
      const pwd =
        sandbox && sandbox !== false
          ? await sandbox.execute(process.platform === 'win32' ? '(Get-Location).Path' : 'pwd')
          : undefined
      expect(pwd).toMatchObject({ exitCode: 0 })
      expect(await realpath(pwd!.stdout.trim())).toBe(realSecondWorkspace)
      const skillsAgent = new Agent({ plugins: [secondOptions.skills], sandbox })
      await skillsAgent.initialize()
      const availableSkills: readonly Skill[] = await secondOptions.skills.getAvailableSkills(skillsAgent)
      expect(availableSkills.map((skill) => ({ ...skill, path: skill.path && normalize(skill.path) }))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'remote', path: join(secondWorkspace, '.agent', 'skills', 'remote') }),
        ])
      )
      expect(mocks.loadMcp).toHaveBeenNthCalledWith(2, {
        cwd: secondWorkspace,
        paths: [explicitMcp],
        strictPaths: [explicitMcp],
        backgroundConnect: true,
        disabledServers: [],
      })
      expect(controller.getSnapshot().runtime).toMatchObject({
        cwd: secondWorkspace,
        session: 'saved-two',
      })
      await controller.submit('/agents')
      const main = controller.getSnapshot().panel?.rows.find((row) => row.label === 'Strands harness')
      await controller.activatePanelRow(main!)
      expect(controller.getSnapshot()).toMatchObject({
        runtime: { cwd: firstWorkspace },
        completedTurns: [{ prompt: 'keep the first workspace alive' }],
      })

      await catalog.refresh()
      expect(catalog.roots()).toEqual(
        expect.arrayContaining([expect.objectContaining({ directory: firstSessions, workspace: firstWorkspace })])
      )

      await controller.dispose()
      disposed = true
      expect(firstMcp.dispose).toHaveBeenCalledOnce()
      expect(secondMcp.dispose).toHaveBeenCalledOnce()
    } finally {
      if (!disposed) {
        await controller.dispose()
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('clears by rebuilding without restoring the active session or conversation snapshot', async () => {
    const firstAgent = fakeAgent('old')
    const replacementAgent = fakeAgent('old')
    mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(replacementAgent)
    const controller = await createInteractiveChat({
      agentOptions: { model: 'bedrock/anthropic.claude-old', session: { id: 'saved-one' } },
    })

    try {
      await controller.submit('Remember this')
      vi.mocked(firstAgent.takeSnapshot).mockClear()
      await controller.submit('/clear')

      expect(mocks.createHarness).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          model: 'bedrock/anthropic.claude-old',
          session: expect.objectContaining({ id: expect.stringMatching(/^\d{8}t\d{6}z-[0-9a-f]{8}$/) }),
        })
      )
      expect(firstAgent.takeSnapshot).not.toHaveBeenCalled()
      expect(replacementAgent.loadSnapshot).not.toHaveBeenCalled()
      expect((controller.backend as StrandsChatBackend).agent).toBe(replacementAgent)
      expect(controller.getSnapshot()).toMatchObject({
        completedTurns: [],
        runtime: { session: expect.stringMatching(/^\d{8}t\d{6}z-[0-9a-f]{8}$/) },
      })
    } finally {
      await controller.dispose()
    }
  })
})

function fakeAgent(modelId: string, id = `agent-${modelId}`, memoryManager?: { flush: () => Promise<void> }): Agent {
  const snapshot = {
    scope: 'agent' as const,
    schemaVersion: '1.0',
    createdAt: '2026-08-07T00:00:00.000Z',
    data: { messages: [], state: { todos: [] }, modelState: {} },
    appData: {},
  }
  const candidate = {
    addHook: vi.fn(),
    id,
    name: 'Strands harness',
    appState: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
    cancel: vi.fn(),
    shutdown: Agent.prototype.shutdown,
    initialize: vi.fn(async () => {}),
    takeSnapshot: vi.fn(() => snapshot),
    loadSnapshot: vi.fn(),
    messages: [],
    model: new BedrockModel({ modelId }),
    toolRegistry: { get: vi.fn() },
    tools: [],
    ...(memoryManager ? { memoryManager } : {}),
    async *stream() {
      yield* []
      return { stopReason: 'endTurn' }
    },
  }
  return candidate as unknown as Agent
}

function configureMeasuredTurn(agent: Agent): void {
  agent.model.updateConfig({ contextWindowLimit: 1_000 })
  agent.stream = async function* () {
    yield* []
    const usage = { inputTokens: 100, outputTokens: 25, totalTokens: 125 }
    const assistant = new Message({
      role: 'assistant',
      content: [new TextBlock('measured')],
      metadata: { usage },
    })
    agent.messages.push(assistant)
    return {
      stopReason: 'endTurn',
      lastMessage: assistant,
      metrics: {
        latestAgentInvocation: {
          usage,
          cycles: [{ usage }],
        },
      },
    } as AgentResult
  }
}

function fakeSubagent(getSteering: () => LiveSteering, capture: (child: LocalAgent) => void): Tool {
  return {
    name: 'subagent',
    description: 'delegate',
    toolSpec: { name: 'subagent', description: 'delegate' },
    stream: async function* (): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
      const child = {
        messages: [],
        addHook: vi.fn(() => () => {}),
      } as unknown as LocalAgent
      capture(child)
      getSteering().observeAgent(child)
      yield { type: 'toolStreamEvent' } as ToolStreamEvent
      return new ToolResultBlock({
        toolUseId: 'tool-1',
        status: 'success',
        content: [],
      })
    },
  } as Tool
}

function exposeBackgroundTask(agent: Agent): void {
  agent.appState.get = vi.fn((key: string) =>
    key === 'strands.backgroundTasks'
      ? [
          {
            taskId: 'task-1',
            toolUseId: 'tool-1',
            toolName: 'subagent',
            status: 'working',
            lastUpdatedAt: '2026-08-16T00:00:00.000Z',
          },
        ]
      : undefined
  )
}

function backgroundToolContext(agent: Agent, task: string): ToolContext {
  return {
    toolUse: {
      name: 'subagent',
      toolUseId: 'tool-1',
      input: { task },
    },
    agent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
    interrupt: vi.fn(),
  } as ToolContext
}

function applySteering(steering: LiveSteering, agent: LocalAgent): void {
  const event = { agent } as BeforeModelCallEvent
  const action = steering.beforeModelCall(event)
  expect(action.type).toBe('transform')
  if (action.type === 'transform') {
    action.apply(event)
  }
}
