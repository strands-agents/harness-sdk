import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  Message,
  TextBlock,
  ToolResultBlock,
  Agent,
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
vi.mock('../src/tui/project/export.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tui/project/export.js')>()),
  exportAgentProject: mocks.exportAgentProject,
}))
vi.mock('../src/tui/mcp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tui/mcp.js')>()),
  loadMcp: mocks.loadMcp,
}))

import {
  createInteractiveChat as createInteractiveChatRuntime,
  interactiveBackgroundTasks,
} from '../src/tui/runtime.js'
import { CliConfigStore } from '../src/tui/config.js'
import { sessionId } from '../src/tui/session/options.js'
import { StrandsChatBackend } from '../src/tui/strands-backend.js'
import { LiveSteering } from '../src/tui/steering.js'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import * as providerDiscovery from '../src/tui/provider/discovery.js'

let testSessionCatalogPath = ''

function createInteractiveChat(
  options: Parameters<typeof createInteractiveChatRuntime>[0] = {}
): ReturnType<typeof createInteractiveChatRuntime> {
  return createInteractiveChatRuntime({
    ...options,
    ...(!options.config && !options.configPath ? { config: CliConfigStore.memory() } : {}),
    sessionCatalogPath: options.sessionCatalogPath ?? testSessionCatalogPath,
  })
}

beforeEach(() => {
  testSessionCatalogPath = join(tmpdir(), `strands-runtime-test-${process.pid}-${randomUUID()}.json`)
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
  await rm(testSessionCatalogPath, { force: true })
})

describe('interactiveBackgroundTasks', () => {
  it('uses detached mode so background work does not hold the composer', () => {
    expect(interactiveBackgroundTasks({})).toEqual({ waitForCompletion: false })
    expect(interactiveBackgroundTasks({ backgroundTasks: true })).toEqual({ waitForCompletion: false })
  })

  it('preserves custom policy while applying the selected interactive wait mode', () => {
    expect(interactiveBackgroundTasks({ backgroundTasks: { always: ['read'], maxConcurrency: 2 } })).toEqual({
      always: ['read'],
      maxConcurrency: 2,
      waitForCompletion: false,
    })
    expect(interactiveBackgroundTasks({ backgroundTasks: { never: ['*'] } }, true)).toEqual({
      never: ['*'],
      waitForCompletion: true,
    })
    expect(interactiveBackgroundTasks({ backgroundTasks: false })).toBe(false)
  })
})

describe('interactive runtime lifecycle', () => {
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
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

      expect(mocks.exportAgentProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Portable', model: 'bedrock/anthropic.claude-new', effort: 'high' }),
        'typescript',
        expect.any(Array),
        process.cwd(),
        undefined
      )
      expect(controller.getSnapshot().panel?.title).toBe('Export complete')
      controller.dismissPanel()
      await controller.submit('/fork')
      await controller.submit('/export')
      await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
      expect(mocks.exportAgentProject).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Portable', model: 'bedrock/anthropic.claude-new', effort: 'high' }),
        'typescript',
        expect.any(Array),
        process.cwd(),
        undefined
      )
    } finally {
      modelDiscovery.mockRestore()
      await controller.dispose()
    }
  })

  it('loads and persists presentation settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-settings-'))
    const configPath = join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify({ settings: { showReasoning: false } }))
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

      expect(JSON.parse(await readFile(configPath, 'utf8')).settings).toMatchObject({
        animations: false,
        showReasoning: false,
      })
    } finally {
      await controller.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('loads persistent permission settings into the Strands backend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-runtime-config-'))
    const configPath = join(directory, 'config.json')
    await writeFile(configPath, JSON.stringify({ permissions: { mode: 'bypassPermissions', allow: ['bash'] } }))
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
          body: expect.stringContaining('WARNING'),
          rows: [
            { label: 'Default (HITL)' },
            { label: 'Bypass', badge: { text: 'Active' } },
            { label: 'bash', control: { kind: 'toggle', checked: true } },
            { label: 'write', control: { kind: 'toggle', checked: false } },
            { label: 'config', description: configPath },
          ],
        },
      })
      const writePermission = controller.getSnapshot().panel?.rows.find((row) => row.label === 'write')
      expect(writePermission).toBeDefined()
      await controller.activatePanelRow(writePermission!)
      expect(JSON.parse(await readFile(configPath, 'utf8')).permissions.allow).toEqual(['bash', 'write'])
    } finally {
      await controller.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('mints a persistent session by default and flushes memory on teardown', async () => {
    const flush = vi.fn(async () => {})
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old', 'agent-old', { flush }))
    const controller = await createInteractiveChat()

    await controller.dispose()
    expect(mocks.createHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ id: expect.stringMatching(/^\d{8}t\d{6}z-[0-9a-f]{8}$/) }),
      })
    )
    expect(flush).toHaveBeenCalledOnce()
  })

  it('keeps the run ephemeral when the session is disabled', async () => {
    mocks.createHarness.mockResolvedValueOnce(fakeAgent('old'))
    const controller = await createInteractiveChat({ agentOptions: { session: false } })

    try {
      expect(mocks.createHarness).toHaveBeenCalledWith(expect.objectContaining({ session: false }))
      expect(mocks.createHarness.mock.calls[0]?.[0].session).toBe(false)
      expect(controller.getSnapshot().runtime).toMatchObject({ session: 'in-memory' })
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
    const forkAgent = fakeAgent('old', 'fork')
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
    'honors peer messaging and discovery settings in new and forked agents (%s)',
    async (enabled) => {
      const firstAgent = fakeAgent('old', 'first')
      const forkAgent = fakeAgent('old', 'fork')
      mocks.createHarness.mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(forkAgent)
      const controller = await createInteractiveChat({
        config: CliConfigStore.memory(
          {},
          {},
          { agentMessaging: enabled, mcpDiscovery: enabled, skillDiscovery: enabled }
        ),
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
        if (!enabled) {
          expect(mainPlugin).toBeUndefined()
          expect(forkPlugin).toBeUndefined()
          expect(mocks.loadMcp).toHaveBeenCalledWith(expect.objectContaining({ paths: [] }))
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

  it('exposes a live background subagent as a temporary task-addressed message endpoint', async () => {
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
      const stream = subagent.stream(backgroundToolContext(parent, 'Review authentication.'))

      await stream.next()
      await expect(
        messageAgent.invoke({ action: 'list' }, { agent: parent } as unknown as ToolContext)
      ).resolves.toEqual({
        agents: [{ id: 'task-1', name: 'subagent: Review authentication.', status: 'working' }],
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
            label: 'subagent: Review authentication.',
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
  })

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
    const conversation = await previous.captureConversation()
    const current = await createInteractiveChat({
      agentOptions: { name: 'After', model: 'bedrock/new', instructions: 'Updated instructions', builtinTools: [] },
      conversation,
    })
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
            configuration: expect.objectContaining({ profile: expect.objectContaining({ name: 'Changed' }) }),
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
    const sessionCatalogPath = join(workspace, 'config', 'session-roots.json')
    await mkdir(join(sessionDirectory, 'saved-one'), { recursive: true })
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
      sessionCatalogPath,
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
        rows: [{ label: 'saved-one', value: 'saved-one' }],
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
        session: 'saved-one',
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
    const sessionCatalogPath = join(workspace, 'config', 'session-roots.json')
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
      sessionCatalogPath,
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
    const firstSessions = join(firstWorkspace, '.agent', 'sessions')
    const secondSessions = join(secondWorkspace, '.agent', 'sessions')
    const catalogPath = join(directory, 'config', 'session-roots.json')
    await mkdir(join(secondSessions, 'saved-two'), { recursive: true })
    await mkdir(join(directory, 'config'), { recursive: true })
    await writeFile(
      catalogPath,
      JSON.stringify({
        version: 1,
        roots: [
          {
            directory: secondSessions,
            workspace: secondWorkspace,
            lastSeenAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      })
    )
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
      agentOptions: { model: 'bedrock/anthropic.claude-old' },
      mcpPaths: [explicitMcp],
      mcpStrictPaths: [explicitMcp],
      sessionCatalogPath: catalogPath,
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
          skills: expect.arrayContaining([expect.stringContaining(secondWorkspace)]),
        })
      )
      const sandbox = secondOptions.sandbox
      expect(sandbox && sandbox !== false).toBe(true)
      const realSecondWorkspace = await realpath(secondWorkspace)
      await expect(sandbox && sandbox !== false ? sandbox.execute('pwd') : undefined).resolves.toMatchObject({
        exitCode: 0,
        stdout: `${realSecondWorkspace}\n`,
      })
      expect(mocks.loadMcp).toHaveBeenNthCalledWith(2, {
        cwd: secondWorkspace,
        paths: [explicitMcp],
        strictPaths: [explicitMcp],
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

      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
        roots: Array<{ directory: string; workspace: string }>
      }
      expect(catalog.roots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ directory: firstSessions, workspace: firstWorkspace }),
          expect.objectContaining({ directory: secondSessions, workspace: secondWorkspace }),
        ])
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
  })

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
    initialize: vi.fn(async () => {}),
    takeSnapshot: vi.fn(() => snapshot),
    loadSnapshot: vi.fn(),
    messages: [],
    model: {
      modelId,
      getConfig: () => ({}),
      updateConfig: vi.fn(),
    },
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
  agent.model.getConfig = () => ({ contextWindowLimit: 1_000 })
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
