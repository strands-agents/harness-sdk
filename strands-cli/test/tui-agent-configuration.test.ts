import { Agent, Model, type JSONValue, type ModelStreamEvent, type ToolContext } from '@strands-agents/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createConfigurationTool, configurationFromStore } from '../src/tui/agent-configuration.js'
import { CliConfigStore } from '../src/tui/config.js'
import { discoverProviderModels } from '../src/tui/provider/discovery.js'
import { CedarPermissions, ToolPermissionBroker } from '../src/tui/permissions/policy.js'

vi.mock('../src/tui/provider/discovery.js', async (original) => ({
  ...(await original<typeof import('../src/tui/provider/discovery.js')>()),
  discoverProviderModels: vi.fn(async () => ({ available: false, models: [] })),
}))

afterEach(() => {
  vi.unstubAllEnvs()
})

function configurationTool(config: CliConfigStore, source?: string) {
  const agent = new Agent()
  const control = createConfigurationTool({
    config,
    profile: () => config.snapshot().profile,
    agent: () => agent,
    ...(source ? { source } : {}),
  })
  const tool = control.tool as unknown as { invoke(input: unknown, context: ToolContext): Promise<string> }
  return {
    ...control,
    agent,
    invoke: (input: JSONValue, caller = agent) =>
      tool.invoke(input, {
        agent: caller,
        toolUse: { name: 'strands_config', toolUseId: 'config', input },
        invocationState: {},
        cancelSignal: new AbortController().signal,
        interrupt: vi.fn(),
      }),
  }
}

class ConfigurationModel extends Model {
  private _nextRequest = 0

  constructor(private readonly _requests: readonly JSONValue[]) {
    super()
  }

  getConfig() {
    return { modelId: 'configuration-test', contextWindowLimit: 10_000 }
  }

  updateConfig() {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    const request = this._requests[this._nextRequest++]
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (request) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'strands_config', toolUseId: `config-${this._nextRequest}` },
      }
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(request) },
      }
    } else {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Done' } }
    }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: request ? 'toolUse' : 'endTurn' }
  }
}

describe('strands_config tool', () => {
  it('discards a denied configuration draft through the SDK tool loop', async () => {
    const config = CliConfigStore.memory()
    const broker = new ToolPermissionBroker()
    let agent: Agent
    const control = createConfigurationTool({
      config,
      profile: () => config.snapshot().profile,
      agent: () => agent,
    })
    const permissions = new CedarPermissions({
      config,
      broker,
      cwd: process.cwd(),
      configurationPreview: () => control.preview(),
      configurationDenied: (revision) => control.discard(revision),
    })
    const requests: string[] = []
    broker.subscribe((request) => {
      if (!request) return
      requests.push(request.action ?? '')
      broker.respond(request.id, 'deny')
    })
    agent = new Agent({
      model: new ConfigurationModel([
        { action: 'update', profile: { name: 'John' } },
        { action: 'apply', revision: 1 },
        { action: 'inspect' },
      ]),
      tools: [control.tool],
      interventions: [permissions],
      printer: false,
      contextManager: false,
    })
    try {
      for await (const _event of agent.stream('Change your name to John')) {
        // Drain the real SDK tool loop.
      }
      const results = agent.messages.flatMap((message) =>
        message.content.filter((block) => block.type === 'toolResultBlock')
      )
      const inspected = JSON.parse(
        results
          .at(-1)!
          .content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : []))
          .join('\n')
      )
      expect(requests).toEqual(['apply'])
      expect(results[1]?.status).toBe('error')
      expect(control.takePending()).toBeUndefined()
      expect(config.snapshot().profile.name).toBe('Strands harness')
      expect(inspected).toMatchObject({ revision: 2, profile: { name: 'Strands harness' } })
      expect(JSON.stringify(control.preview())).not.toContain('John')
      expect(control.discard(2)).toBe(false)
    } finally {
      broker.dispose()
    }
  })

  it('discards only the matching draft and pending apply', async () => {
    const config = CliConfigStore.memory()
    const control = configurationTool(config)
    expect(control.discard(0)).toBe(false)
    await control.invoke({ action: 'update', profile: { name: 'John' } })
    await control.invoke({ action: 'update', profile: { name: 'Jimmy' } })
    await control.invoke({ action: 'apply', revision: 2 })
    expect(control.discard(1)).toBe(false)
    expect(control.profile().name).toBe('Jimmy')
    expect(control.takePending()?.configuration?.profile.name).toBe('Jimmy')
    await control.invoke({ action: 'apply', revision: 2 })
    expect(control.discard(2)).toBe(true)
    expect(control.takePending()).toBeUndefined()
    expect(control.profile()).toEqual(config.snapshot().profile)
    expect(JSON.stringify(control.preview())).not.toContain('Jimmy')
    expect(JSON.parse(await control.invoke({ action: 'inspect' })).revision).toBe(3)
    expect(control.discard(3)).toBe(false)
  })

  it('captures every setting for rollback without sharing mutable settings with the store', () => {
    const config = CliConfigStore.memory(
      {},
      {
        frogTheme: 'oak',
        transcriptSpacing: 'compact',
        animations: false,
        showReasoning: false,
        toolOutput: 'hidden',
        mcpDiscovery: true,
        skillDiscovery: true,
        agentMessaging: false,
      }
    )
    const configuration = configurationFromStore(config)
    expect(configuration.settings).toEqual(config.snapshot().settings)
    configuration.settings!.animations = true
    expect(config.snapshot().settings.animations).toBe(false)
  })

  it('redacts credentials in inspect and update responses without changing the draft or saved values', async () => {
    const config = CliConfigStore.memory(
      {},
      {},
      {
        profile: {
          mcpServers: {
            private: {
              url: 'https://example.invalid/mcp',
              headers: { Authorization: 'Bearer FAKE_REVIEW_TOKEN', 'X-Custom': 'FAKE_HEADER_VALUE' },
              env: { SERVICE_CONFIG: 'FAKE_ENV_VALUE', API_KEY: '${env:API_KEY}' },
              args: ['--api-key', 'FAKE_ARGUMENT_VALUE'],
            },
            authenticated: { url: 'https://user:FAKE_URL_PASSWORD@example.invalid/mcp' },
          },
          agentConfig: { backgroundTasks: false, nested: { apiKey: 'FAKE_NESTED_KEY', enabled: true } },
        },
      }
    )
    const original = config.snapshot().profile
    const control = configurationTool(config)
    const responses = [
      await control.invoke({ action: 'inspect' }),
      await control.invoke({ action: 'update', profile: { name: 'Renamed' } }),
    ]
    for (const response of responses) {
      expect(response).not.toContain('FAKE_')
      expect(JSON.parse(response).profile).toMatchObject({
        mcpServers: {
          private: {
            url: 'https://example.invalid/mcp',
            headers: { Authorization: '[redacted]', 'X-Custom': '[redacted]' },
            env: { SERVICE_CONFIG: '[redacted]', API_KEY: '${env:API_KEY}' },
            args: '[redacted]',
          },
          authenticated: { url: '[redacted]' },
        },
        agentConfig: { backgroundTasks: false, nested: { apiKey: '[redacted]', enabled: true } },
      })
    }
    expect(config.snapshot().profile).toEqual(original)
    expect(control.profile()).toEqual({ ...original, name: 'Renamed' })
    expect(JSON.stringify(control.preview())).not.toContain('FAKE_')
    expect(control.preview().lines).toContainEqual(
      expect.objectContaining({ kind: 'add', text: expect.stringContaining('Renamed') })
    )
    const inspected = JSON.parse(await control.invoke({ action: 'inspect' }))
    await expect(
      control.invoke({ action: 'update', profile: { ...inspected.profile, name: 'Corrupted' } })
    ).rejects.toThrow('Send only changed fields and omit credential fields')
    await expect(
      control.invoke({ action: 'update', profile: { agentConfig: { values: ['[redacted]'] } } })
    ).rejects.toThrow('Do not copy [redacted]')
    expect(control.profile()).toEqual({ ...original, name: 'Renamed' })
    expect(config.snapshot().profile).toEqual(original)
    expect(JSON.parse(await control.invoke({ action: 'inspect' })).revision).toBe(inspected.revision)
  })

  it('applies unrelated edits with the default feature semantics and rejects explicitly unsupported tools', async () => {
    const config = CliConfigStore.memory()
    const control = configurationTool(config)
    await control.invoke({ action: 'update', profile: { name: 'Renamed' } })
    await expect(control.invoke({ action: 'apply', revision: 1 })).resolves.toContain('Configuration validated')
    expect(control.takePending()?.configuration?.profile).toEqual({ ...config.snapshot().profile, name: 'Renamed' })
    await control.invoke({ action: 'update', profile: { builtinTools: ['read', 'web_search'] } })
    await expect(control.invoke({ action: 'apply', revision: 2 })).rejects.toThrow('has no native web search')
    expect(control.takePending()).toBeUndefined()
    expect(control.profile().builtinTools).toEqual(['read', 'web_search'])
    expect(JSON.parse(await control.invoke({ action: 'inspect' })).revision).toBe(2)
  })

  it('rejects new literal credentials without changing the draft and accepts environment references', async () => {
    vi.stubEnv('STRANDS_CLI_TEST_API_KEY', 'FAKE_ENV_TOKEN')
    const config = CliConfigStore.memory(
      {},
      {},
      {
        profile: { agentConfig: { apiKey: 'FAKE_EXISTING_TOKEN' } },
      }
    )
    const control = configurationTool(config)
    const original = control.profile()
    for (const profile of [
      { mcpServers: { service: { url: 'https://example.invalid', headers: { Authorization: 'Bearer FAKE_TOKEN' } } } },
      { mcpServers: { service: { command: 'server', args: ['--api-key', 'FAKE_TOKEN'] } } },
      { agentConfig: { nested: { apiKey: 'FAKE_TOKEN' } } },
    ]) {
      await expect(control.invoke({ action: 'update', profile })).rejects.toThrow('environment placeholder')
      expect(control.profile()).toEqual(original)
      expect(JSON.parse(await control.invoke({ action: 'inspect' })).revision).toBe(0)
      expect(control.takePending()).toBeUndefined()
    }
    await control.invoke({
      action: 'update',
      profile: {
        name: 'Updated',
        mcpServers: {
          service: {
            url: 'https://example.invalid',
            headers: { Authorization: 'Bearer ${env:STRANDS_CLI_TEST_API_KEY}' },
          },
        },
      },
    })
    await control.invoke({ action: 'apply', revision: 1 })
    const change = control.takePending()!
    expect(change.configuration?.profile).toMatchObject({
      name: 'Updated',
      agentConfig: { apiKey: 'FAKE_EXISTING_TOKEN' },
      mcpServers: { service: { headers: { Authorization: 'Bearer ${env:STRANDS_CLI_TEST_API_KEY}' } } },
    })
    expect(config.snapshot().profile).toEqual(original)
  })

  it('preserves optional default caching and explicit overrides when validating local models', async () => {
    const config = CliConfigStore.memory(
      {},
      {},
      // ollama supports no reasoning levels; pin effort to 'auto' so the default 'high' is not
      // rejected by resolveEffort (see #4472).
      { profile: { model: 'ollama/review-model', builtinTools: [], effort: 'auto' } }
    )
    const control = configurationTool(config)
    await control.invoke({ action: 'update', profile: { name: 'Local Strands harness' } })
    await expect(control.invoke({ action: 'apply', revision: 1 })).resolves.toContain('Configuration validated')
    expect(control.takePending()?.configuration?.profile.caching).toBe(true)
    await control.invoke({ action: 'update', profile: { agentConfig: { caching: false } } })
    await expect(control.invoke({ action: 'apply', revision: 2 })).resolves.toContain('Configuration validated')
    expect(control.takePending()?.configuration?.profile.agentConfig.caching).toBe(false)
    await control.invoke({ action: 'update', profile: { agentConfig: { caching: true } } })
    await expect(control.invoke({ action: 'apply', revision: 3 })).rejects.toThrow('does not support prompt caching')
    expect(control.takePending()).toBeUndefined()
  })

  it('gives the agent a model-listing recovery hint and records reload failures in its conversation', async () => {
    // ollama supports no reasoning levels; pin effort to 'auto' so the default 'high' is not
    // rejected by resolveEffort (see #4472).
    const config = CliConfigStore.memory(
      {},
      {},
      { profile: { model: 'ollama/missing', builtinTools: [], effort: 'auto' } }
    )
    const control = configurationTool(config)
    vi.mocked(discoverProviderModels).mockResolvedValueOnce({
      available: true,
      models: [{ id: 'available', name: 'Available' }],
    })
    await expect(control.invoke({ action: 'apply', revision: 0 })).rejects.toThrow(
      'Use strands_config with action "models"'
    )
    expect(control.takePending()).toBeUndefined()
    await control.invoke({ action: 'update', profile: { model: 'ollama/available' } })
    await control.invoke({ action: 'apply', revision: 1 })
    await control.takePending()!.onFailure!('MCP server example could not connect')
    expect(control.agent.messages.at(-1)?.toJSON()).toMatchObject({
      role: 'user',
      content: [
        {
          text: expect.stringContaining('The previous agent remains active.\nReason: MCP server example'),
        },
      ],
    })
    expect(config.snapshot().profile.model).toBe('ollama/missing')
  })

  it('stages a portable patch without changing the saved profile, then validates an apply request', async () => {
    const config = CliConfigStore.memory(
      {},
      {},
      {
        profile: { builtinTools: ['read'], agentConfig: { backgroundTasks: false, maxParallelTools: 2 } },
        profileBaseDir: '/tmp',
      }
    )
    const original = configurationFromStore(config)
    const control = configurationTool(config)
    await control.invoke({
      action: 'update',
      profile: {
        name: 'Code Guide',
        instructions: 'Explain changes concisely.',
        builtinTools: ['read', 'edit'],
        builtinPlugins: ['todos'],
        skills: ['./skills'],
        contextManager: 'agentic',
        agentConfig: { backgroundTasks: true },
        mcpServers: { research: { command: 'node', args: ['mcp-server.js'] } },
      },
      settings: { skillDiscovery: true },
      permissionMode: 'bypassPermissions',
      allowedTools: ['edit', 'read'],
    })
    expect(config.snapshot().profile).toEqual(original.profile)
    expect(control.profile()).toMatchObject({
      name: 'Code Guide',
      builtinTools: ['read', 'edit'],
      agentConfig: { backgroundTasks: true, maxParallelTools: 2 },
    })
    const additions = control
      .preview()
      .lines.filter((line) => line.kind === 'add')
      .map((line) => line.text)
      .join('\n')
    expect(additions).toContain('bypassPermissions')
    expect(additions).toContain('edit')
    expect(additions).toContain('research')
    expect(additions).toContain('mcp-server.js')
    await control.invoke({ action: 'apply', revision: 1 })
    const pending = control.takePending()
    expect(pending?.configuration).toMatchObject({
      profileBaseDir: '/tmp',
      profile: { name: 'Code Guide', skills: ['./skills'], contextManager: 'agentic' },
      settings: { skillDiscovery: true },
      allowedTools: ['edit', 'read'],
    })
    expect(control.takePending()).toBeUndefined()
    expect(config.snapshot().profile).toEqual(original.profile)
    await config.saveSetup(pending!.configuration!)
    expect(config.snapshot().profile).toEqual(control.profile())
  })

  it('rejects invalid fields, delegated changes, and drafts changed during validation', async () => {
    const config = CliConfigStore.memory({}, {}, { profile: { builtinTools: ['read'] } })
    const control = configurationTool(config)
    await expect(control.invoke({ action: 'update', profile: { contextStrategy: 'off' } })).rejects.toThrow(
      'Unknown profile field'
    )
    await expect(control.invoke({ action: 'inspect' }, new Agent())).rejects.toThrow('Only the main')
    await expect(control.invoke({ action: 'update', profile: { contextManager: 'invalid' } })).rejects.toThrow()
    const inspected = JSON.parse(await control.invoke({ action: 'inspect' }))
    await control.invoke({ action: 'update', profile: { name: 'Changed before approval' } })
    await expect(control.invoke({ action: 'apply', revision: inspected.revision })).rejects.toThrow(
      'Inspect the latest configuration'
    )
    let finishDiscovery!: (value: Awaited<ReturnType<typeof discoverProviderModels>>) => void
    vi.mocked(discoverProviderModels).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDiscovery = resolve
        })
    )
    const applying = control.invoke({ action: 'apply', revision: 1 })
    const rejected = expect(applying).rejects.toThrow('changed during validation')
    await vi.waitFor(() => expect(finishDiscovery).toBeDefined())
    await control.invoke({ action: 'update', profile: { name: 'Newer draft' } })
    finishDiscovery({ available: false, models: [] })
    await rejected
    expect(control.takePending()).toBeUndefined()
    expect(config.snapshot().profile.name).toBe('Strands harness')
  })

  it('keeps source-backed edits in source and requests a reload without overwriting the global profile', async () => {
    const config = CliConfigStore.memory()
    const control = configurationTool(config, '/tmp/custom-agent/agent.ts')
    const inspected = JSON.parse(await control.invoke({ action: 'inspect' }))
    expect(inspected.target.source).toBe('/tmp/custom-agent/agent.ts')
    expect(inspected.profile).toBeUndefined()
    await expect(control.invoke({ action: 'update', profile: { name: 'Changed' } })).rejects.toThrow('Edit that source')
    await control.invoke({ action: 'apply', revision: inspected.revision })
    expect(control.takePending()).toEqual({
      agentProject: '/tmp/custom-agent/agent.ts',
      onFailure: expect.any(Function),
    })
    expect(config.snapshot().profile.name).toBe('Strands harness')
  })
})
