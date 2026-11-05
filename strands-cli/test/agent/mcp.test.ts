import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { SdkErrorCode } from '@modelcontextprotocol/client'
import { defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'
import { Agent, McpClient } from '@strands-agents/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultMcpPaths, loadMcp, projectMcpPaths, readMcpDefinitions } from '../../src/agent/mcp.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { startRemoteMcpServer } from '../fixtures/remote-mcp.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const stdioTransports = vi.hoisted(() => [] as Record<string, unknown>[])
const stdioClientConfigs = vi.hoisted(() => [] as { prefix?: string; applicationName?: string }[])

vi.mock('@strands-agents/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@strands-agents/sdk')>()
  class RecordingMcpClient extends actual.McpClient {
    constructor(config: ConstructorParameters<typeof actual.McpClient>[0]) {
      super(config)
      stdioClientConfigs.push(config)
    }
  }
  return { ...actual, McpClient: RecordingMcpClient }
})

vi.mock('@modelcontextprotocol/client/stdio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>()
  function RecordingStdioClientTransport(
    params: ConstructorParameters<typeof actual.StdioClientTransport>[0]
  ): InstanceType<typeof actual.StdioClientTransport> {
    stdioTransports.push(params)
    return new actual.StdioClientTransport(params)
  }
  return { ...actual, StdioClientTransport: RecordingStdioClientTransport }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  stdioTransports.length = 0
  stdioClientConfigs.length = 0
})

describe('loadMcp', () => {
  it('connects to a legacy stdio server that closes on protocol discovery', async () => {
    const server = `
      const readline = require('node:readline')
      let name = 'probe'
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const request = JSON.parse(line)
        if (request.method === 'server/discover') process.exit(0)
        let result
        if (request.method === 'initialize') {
          result = {
            protocolVersion: '2025-11-25',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'legacy', version: '1.0' },
          }
        }
        if (request.method === 'tools/list') {
          result = { tools: [{ name, inputSchema: { type: 'object' } }] }
        }
        if (request.method === 'tools/call') {
          name = 'updated'
          result = { content: [{ type: 'text', text: 'updated' }] }
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\\n')
        }
        if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
      })
    `
    const loaded = await loadMcp({
      paths: [],
      servers: { legacy: { command: process.execPath, args: ['-e', server] } },
      backgroundConnect: true,
    })
    try {
      const agent = new Agent({ tools: [...loaded.clients], printer: false })
      const registered: string[][] = []
      const stop = loaded.subscribeTools?.(() => registered.push(agent.toolRegistry.list().map((tool) => tool.name)))
      await agent.initialize()
      await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
      expect(await loaded.list(true)).toMatchObject([
        { name: 'legacy', state: 'connected', toolCount: 1, source: 'Agent configuration', canRetry: true },
      ])
      await vi.waitFor(() => expect(registered).toContainEqual(['legacy_probe']))
      const client = loaded.clients[0]!
      const [tool] = await client.listTools()
      await client.callTool(tool!, {})
      await vi.waitFor(() => expect(registered).toContainEqual(['legacy_updated']))
      await loaded.setEnabled?.('legacy', false)
      expect(registered.at(-1)).toEqual([])
      stop?.()
      const notifications = registered.length
      await loaded.setEnabled?.('legacy', true)
      expect(registered).toHaveLength(notifications)
    } finally {
      await loaded.dispose()
    }
  })

  it('discovers conventional user and project configuration locations in stable precedence order', () => {
    const posix = (path: string): string => path.replaceAll(sep, '/')
    expect(defaultMcpPaths().map((path) => posix(path).replace(posix(homedir()), '~'))).toEqual([
      '~/.claude.json',
      '~/.kiro/settings/mcp.json',
      '~/.gemini/settings.json',
      '~/.codex/config.toml',
      '~/.strands/mcp.json',
    ])
    expect(projectMcpPaths('/workspace').map(posix)).toEqual([
      '/workspace/.mcp.json',
      '/workspace/.kiro/settings/mcp.json',
      '/workspace/.gemini/settings.json',
      '/workspace/.codex/config.toml',
      '/workspace/.strands/mcp.json',
    ])
  })

  it('translates Codex TOML servers, auth headers, and tool filters', async () => {
    const directory = await temporaryDirectory('strands-mcp-codex-')
    const path = join(directory, 'config.toml')
    await writeFile(
      path,
      [
        '[mcp_servers.context7]',
        'url = "https://example.com/mcp"',
        'bearer_token_env_var = "CONTEXT7_TOKEN"',
        'enabled_tools = ["resolve-library-id"]',
        'disabled_tools = ["delete-library"]',
      ].join('\n')
    )
    vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])

    const loaded = await loadMcp({ paths: [path] })
    expect(McpClient.loadServers).toHaveBeenCalledWith(
      {
        context7: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${CONTEXT7_TOKEN}' },
          continueOnError: true,
          toolFilters: {
            allowed: ['^resolve-library-id$'],
            rejected: ['^delete-library$'],
          },
        },
      },
      expect.not.objectContaining({ applicationName: expect.anything() }), // named per server by the SDK
      { prefixWithServerName: true }
    )
    await loaded.dispose()
  })

  it('loads Claude user and current-project local scopes from ~/.claude.json shape', async () => {
    const directory = await temporaryDirectory('strands-mcp-claude-')
    const path = join(directory, '.claude.json')
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          shared: { command: 'user-server' },
          global: { command: 'global-server' },
        },
        projects: {
          [directory]: {
            mcpServers: {
              shared: { command: 'local-server' },
              local: { command: 'project-server' },
            },
          },
        },
      })
    )
    vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])

    try {
      const loaded = await loadMcp({ cwd: directory, paths: [path] })
      expect(await loaded.list()).toMatchObject([
        { name: 'shared', target: 'local-server' },
        { name: 'global', target: 'global-server' },
        { name: 'local', target: 'project-server' },
      ])
      await loaded.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['inline', 'file'] as const)(
    'preserves SDK OAuth and task settings from %s configuration',
    async (source) => {
      const directory = await temporaryDirectory('strands-mcp-auth-')
      const path = join(directory, 'mcp.json')
      const auth = {
        clientId: '${env:MCP_CLIENT_ID}',
        clientSecret: '${MCP_CLIENT_SECRET}',
        scopes: ['tools:read', '${env:MCP_SCOPE}'],
      }
      const servers = {
        authenticated: {
          url: 'https://example.com/mcp',
          type: 'http',
          auth,
          http_headers: { 'X-Account': 'example' },
          toolFilters: { allowed: ['^read_'], rejected: ['^read_secret$'] },
          tasksConfig: { requestTimeout: 2_000, pollTimeout: 10_000, pollInterval: 100, ttl: 1_000 },
          continueOnError: false,
        },
      }
      await writeFile(path, JSON.stringify({ mcpServers: servers }))
      const loadServers = vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])

      const loaded = await loadMcp({ paths: [], servers: source === 'inline' ? servers : path })
      expect(loadServers).toHaveBeenCalledWith(
        {
          authenticated: {
            url: 'https://example.com/mcp',
            transport: 'streamable-http',
            headers: { 'X-Account': 'example' },
            auth,
            toolFilters: servers.authenticated.toolFilters,
            tasksConfig: servers.authenticated.tasksConfig,
            continueOnError: false,
          },
        },
        expect.not.objectContaining({ applicationName: expect.anything() }),
        { prefixWithServerName: true }
      )
      expect(loaded.paths).toEqual(source === 'file' ? [path] : [])
      expect(await loaded.list()).toMatchObject([
        { name: 'authenticated', source: source === 'file' ? path : 'Agent configuration', canRetry: false },
      ])
      await loaded.dispose()
    }
  )

  it.each(['requestTimeout', 'pollTimeout', 'pollInterval', 'ttl'])(
    'rejects an invalid MCP task %s before loading a server',
    async (field) => {
      await expect(
        readMcpDefinitions({
          paths: [],
          servers: { remote: { url: 'https://example.com/mcp', tasksConfig: { [field]: -1 } } },
        })
      ).rejects.toThrow(`tasksConfig.${field}`)
    }
  )

  it.each([{ name: 'omitted' }, { name: 'empty', scopes: [] as string[] }])(
    'preserves $name OAuth scopes',
    async ({ scopes }) => {
      const auth = { clientId: '', clientSecret: '', ...(scopes === undefined ? {} : { scopes }) }
      const { definitions } = await readMcpDefinitions({
        paths: [],
        servers: { remote: { url: 'https://example.com/mcp', auth } },
      })
      expect(definitions.remote?.auth).toEqual(auth)
    }
  )

  it('preserves expanded OAuth credentials from profile servers', async () => {
    vi.stubEnv('STRANDS_TEST_MCP_CLIENT_ID', 'test-client')
    vi.stubEnv('STRANDS_TEST_MCP_CLIENT_SECRET', 'test-secret')
    vi.stubEnv('STRANDS_TEST_MCP_SCOPE', 'tools:read')
    const options = await harnessAgentOptionsFromConfig(
      defineHarnessAgentConfig({
        mcpServers: {
          remote: {
            url: 'https://example.com/mcp',
            auth: {
              clientId: '${env:STRANDS_TEST_MCP_CLIENT_ID}',
              clientSecret: '${STRANDS_TEST_MCP_CLIENT_SECRET}',
              scopes: ['${env:STRANDS_TEST_MCP_SCOPE}'],
            },
          },
        },
      })
    )
    const loadServers = vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])

    const loaded = await loadMcp({ paths: [], servers: options.mcpServers! })
    expect(loadServers).toHaveBeenCalledWith(
      {
        remote: {
          url: 'https://example.com/mcp',
          auth: { clientId: 'test-client', clientSecret: 'test-secret', scopes: ['tools:read'] },
          continueOnError: true,
        },
      },
      expect.anything(),
      { prefixWithServerName: true }
    )
    await loaded.dispose()
  })

  it('lets profile servers replace or disable discovered servers', async () => {
    const directory = await temporaryDirectory('strands-mcp-profile-')
    const path = join(directory, 'mcp.json')
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { shared: { command: 'old-server' }, disabled: { command: 'unused-server' } },
      })
    )
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    const loaded = await loadMcp({
      paths: [path],
      servers: {
        shared: { command: 'new-server' },
        disabled: { disabled: true },
        authored: { command: 'node', args: ['./server.js'], cwd: directory },
      },
    })
    expect(await loaded.list()).toMatchObject([
      { name: 'shared', target: 'new-server', source: 'Agent configuration' },
      { name: 'authored', target: 'node', source: 'Agent configuration' },
    ])
    await loaded.dispose()
  })

  it('tracks the winning configuration source and removes disabled inherited sources', async () => {
    const directory = await temporaryDirectory('strands-mcp-sources-')
    const user = join(directory, 'user.json')
    const project = join(directory, 'project.json')
    await writeFile(
      user,
      JSON.stringify({
        mcpServers: {
          retained: { command: 'user-server' },
          replaced: { command: 'old-server' },
          removed: { command: 'unused-server' },
          authored: { command: 'old-authored-server' },
        },
      })
    )
    await writeFile(
      project,
      JSON.stringify({
        mcpServers: {
          replaced: { command: 'project-server' },
          removed: { disabled: true },
        },
      })
    )

    const { definitions, sources } = await readMcpDefinitions({
      paths: [user, project],
      servers: { authored: { command: 'agent-server' } },
    })
    expect(definitions).toMatchObject({
      retained: { command: 'user-server' },
      replaced: { command: 'project-server' },
      authored: { command: 'agent-server' },
    })
    expect(definitions).not.toHaveProperty('removed')
    expect(sources).toEqual({
      retained: user,
      replaced: project,
      authored: 'Agent configuration',
    })
  })

  it('loads a server named __proto__ and honors its profile override', async () => {
    const directory = await temporaryDirectory('strands-mcp-name-')
    const path = join(directory, 'mcp.json')
    const server = await startRemoteMcpServer('http', {}, { toolNames: ['probe'] })
    await writeFile(path, JSON.stringify({ mcpServers: { ['__proto__']: { url: server.url } } }))
    const loaded = await loadMcp({ paths: [path], backgroundConnect: true })
    try {
      expect(await loaded.list(true)).toMatchObject([
        { name: '__proto__', state: 'connected', source: path, toolCount: 1 },
      ])
      expect((await loaded.clients[0]!.listTools()).map((tool) => tool.name)).toEqual(['__proto___probe'])
      const replaced = await readMcpDefinitions({
        paths: [path],
        servers: { ['__proto__']: { command: 'replacement' } },
      })
      expect(Object.keys(replaced.definitions)).toEqual(['__proto__'])
      expect(replaced.definitions['__proto__']?.command).toBe('replacement')
      expect(replaced.sources['__proto__']).toBe('Agent configuration')
      const disabled = await readMcpDefinitions({
        paths: [path],
        servers: { ['__proto__']: { disabled: true } },
      })
      expect(Object.keys(disabled.definitions)).toEqual([])
      expect(Object.keys(disabled.sources)).toEqual([])
    } finally {
      await loaded.dispose()
      await server.close()
    }
  })

  it('disables a server with missing startup environment and retains its error when re-enabled', async () => {
    vi.stubEnv('STRANDS_TEST_MCP_MISSING_COMMAND', undefined)
    const loaded = await loadMcp({
      paths: [],
      servers: { broken: { command: '${STRANDS_TEST_MCP_MISSING_COMMAND}' } },
      backgroundConnect: true,
    })
    const error = 'Environment variable "STRANDS_TEST_MCP_MISSING_COMMAND" is not set.'
    try {
      expect(loaded.clients).toEqual([])
      expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 0, failed: 1 })
      expect(await loaded.list(true)).toMatchObject([{ name: 'broken', state: 'failed', canRetry: false, error }])

      await expect(loaded.setEnabled!('broken', false)).resolves.toBeUndefined()
      const [disabled] = await loaded.list(true)
      expect(disabled).toMatchObject({ name: 'broken', state: 'disabled', canRetry: false })
      expect(disabled).not.toHaveProperty('error')

      vi.stubEnv('STRANDS_TEST_MCP_MISSING_COMMAND', process.execPath)
      await expect(loaded.setEnabled!('broken', true)).resolves.toBe(error)
      expect(await loaded.list(true)).toMatchObject([{ name: 'broken', state: 'failed', canRetry: false, error }])
      expect(stdioTransports).toEqual([])
    } finally {
      await loaded.dispose()
    }
  })

  it('answers listTools without blocking on a slow server and delivers its tools once connected', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const connect = vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: unknown) {
      await gate
      ;(this as { _state: string })._state = 'connected'
    })
    const tools = [{ name: 'slow_tool' }] as unknown as Awaited<ReturnType<McpClient['listTools']>>
    const listTools = vi.spyOn(McpClient.prototype, 'listTools').mockResolvedValue(tools)

    const loaded = await loadMcp({ paths: [], servers: { slow: { command: 'slow-server' } }, backgroundConnect: true })
    try {
      const client = loaded.clients[0]!
      expect(connect).toHaveBeenCalledTimes(1)

      await expect(client.listTools()).resolves.toEqual([])
      expect(listTools).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledTimes(1)
      expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 0, failed: 0 })

      const changed = vi.fn()
      const progressed = vi.fn()
      loaded.startup?.subscribe(progressed)
      client.onToolsChanged = changed
      release()
      await vi.waitFor(() => expect(changed).toHaveBeenCalledWith([], tools))
      await vi.waitFor(() => expect(progressed).toHaveBeenCalled())
      expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 })
    } finally {
      vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)
      await loaded.dispose()
    }
  })

  it.each([true, false])('preserves tool-list recovery with continueOnError=%s', async (continueOnError) => {
    const server = await startRemoteMcpServer('http', {}, { toolNames: ['probe', 'x'.repeat(65)] })
    const loaded = await loadMcp({
      paths: [],
      servers: { remote: { url: server.url, continueOnError } },
      backgroundConnect: true,
    })
    const toolsChanged = vi.fn()
    loaded.clients[0]!.onToolsChanged = toolsChanged
    try {
      await loaded.clients[0]!.listTools()
      await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
      if (continueOnError) {
        await vi.waitFor(() =>
          expect(toolsChanged).toHaveBeenCalledWith([], [expect.objectContaining({ name: 'remote_probe' })])
        )
        expect((await loaded.clients[0]!.listTools()).map((tool) => tool.name)).toEqual(['remote_probe'])
        expect(await loaded.list(true)).toMatchObject([{ state: 'connected', toolCount: 1 }])
      } else {
        await expect(loaded.clients[0]!.listTools()).rejects.toThrow('tool name exceeds registry limit')
        expect(toolsChanged).not.toHaveBeenCalled()
      }
    } finally {
      await loaded.dispose()
      await server.close()
    }
  })

  it('discards an in-flight tool list when its server is disabled', async () => {
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: McpClient) {
      Reflect.set(this, '_state', 'connected')
    })
    vi.spyOn(McpClient.prototype, 'disconnect').mockImplementation(async function (this: McpClient) {
      Reflect.set(this, '_state', 'disconnected')
    })
    let finishList!: (tools: Awaited<ReturnType<McpClient['listTools']>>) => void
    vi.spyOn(McpClient.prototype, 'listTools').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishList = resolve
        })
    )
    const loaded = await loadMcp({
      paths: [],
      servers: { local: { command: 'local-server' } },
      backgroundConnect: true,
    })
    try {
      await loaded.clients[0]!.connect()
      const listing = loaded.clients[0]!.listTools()
      await loaded.setEnabled!('local', false)
      finishList([{ name: 'local_stale' }] as Awaited<ReturnType<McpClient['listTools']>>)
      await expect(listing).resolves.toEqual([])
    } finally {
      await loaded.dispose()
    }
  })

  it('reconnects a disabled stdio server and restores its tools across repeated toggles', async () => {
    const directory = await temporaryDirectory('strands-mcp-reconnect-')
    const loaded = await loadMcp({
      paths: [],
      servers: {
        local: {
          command: process.execPath,
          args: [fileURLToPath(new URL('../fixtures/platform-integration-mcp.mjs', import.meta.url))],
          cwd: directory,
        },
      },
      backgroundConnect: true,
    })
    const client = loaded.clients[0]!
    const toolsChanged = vi.fn()
    client.onToolsChanged = toolsChanged
    const callProbe = async (): Promise<void> => {
      const tools = await client.listTools()
      expect(tools.map((tool) => tool.name)).toEqual(['local_probe'])
      await expect(client.callTool(tools[0]!, {})).resolves.toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('platform-mcp-ok') }],
      })
    }
    try {
      await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
      await callProbe()

      for (let cycle = 0; cycle < 2; cycle++) {
        await expect(loaded.setEnabled!('local', false)).resolves.toBeUndefined()
        expect(await loaded.list()).toMatchObject([{ name: 'local', state: 'disabled' }])
        await expect(client.listTools()).resolves.toEqual([])
        expect(toolsChanged).toHaveBeenLastCalledWith(['local_probe'], [])

        await expect(loaded.setEnabled!('local', true)).resolves.toBeUndefined()
        expect(await loaded.list(true)).toMatchObject([{ name: 'local', state: 'connected', toolCount: 1 }])
        expect(toolsChanged).toHaveBeenLastCalledWith([], [expect.objectContaining({ name: 'local_probe' })])
        await callProbe()
      }
    } finally {
      await loaded.dispose()
    }
  })

  it.each(['http', 'sse'] as const)(
    'reconnects a disabled %s server with its headers, tool filters, and prefix intact',
    async (transport) => {
      const headers = { Authorization: 'Bearer reconnect-test', 'X-Test-Account': 'local' }
      const server = await startRemoteMcpServer(transport, headers)
      const loaded = await loadMcp({
        paths: [],
        servers: {
          remote: {
            url: server.url,
            type: transport,
            headers,
            prefix: 'kept',
            toolFilters: { allowed: ['^probe'], rejected: ['^probe_hidden$'] },
          },
        },
        backgroundConnect: true,
      })
      const client = loaded.clients[0]!
      const toolsChanged = vi.fn()
      client.onToolsChanged = toolsChanged
      const callProbe = async (): Promise<void> => {
        const tools = await client.listTools()
        expect(tools.map((tool) => tool.name)).toEqual(['kept_probe'])
        await expect(client.callTool(tools[0]!, {})).resolves.toMatchObject({
          content: [{ type: 'text', text: JSON.stringify({ marker: 'remote-mcp-ok', client: 'remote' }) }],
        })
      }
      try {
        await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
        await callProbe()
        expect(server.connections()).toBe(1)

        for (let cycle = 0; cycle < 2; cycle++) {
          await expect(loaded.setEnabled!('remote', false)).resolves.toBeUndefined()
          expect(await loaded.list()).toMatchObject([{ name: 'remote', state: 'disabled' }])
          await expect(client.listTools()).resolves.toEqual([])
          expect(toolsChanged).toHaveBeenLastCalledWith(['kept_probe'], [])

          await expect(loaded.setEnabled!('remote', true)).resolves.toBeUndefined()
          expect(await loaded.list(true)).toMatchObject([{ name: 'remote', state: 'connected', toolCount: 1 }])
          expect(toolsChanged).toHaveBeenLastCalledWith([], [expect.objectContaining({ name: 'kept_probe' })])
          await callProbe()
          expect(server.connections()).toBe(cycle + 2)
        }
      } finally {
        await loaded.dispose()
        await server.close()
      }
    }
  )

  it.each(['http', 'sse'] as const)(
    'retries a failed %s connection with refreshed environment headers',
    async (transport) => {
      vi.stubEnv('STRANDS_TEST_MCP_AUTH', 'Bearer expired-test')
      const server = await startRemoteMcpServer(transport, { Authorization: 'Bearer refreshed-test' })
      const loaded = await loadMcp({
        paths: [],
        servers: {
          remote: {
            url: server.url,
            type: transport,
            headers: { Authorization: '${env:STRANDS_TEST_MCP_AUTH}' },
            prefix: 'retry',
            toolFilters: { allowed: ['^probe$'] },
          },
        },
        backgroundConnect: true,
      })
      const client = loaded.clients[0]!
      const toolsChanged = vi.fn()
      client.onToolsChanged = toolsChanged
      try {
        await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 0, failed: 1 }))
        expect(await loaded.list()).toMatchObject([{ name: 'remote', state: 'failed', error: expect.any(String) }])
        await expect(client.listTools()).resolves.toEqual([])
        expect(server.connections()).toBe(0)

        vi.stubEnv('STRANDS_TEST_MCP_AUTH', 'Bearer refreshed-test')
        await expect(loaded.setEnabled!('remote', true)).resolves.toBeUndefined()
        const info = (await loaded.list(true))[0]!
        expect(info).toMatchObject({ name: 'remote', state: 'connected', toolCount: 1 })
        expect(info).not.toHaveProperty('error')
        expect(toolsChanged).toHaveBeenLastCalledWith([], [expect.objectContaining({ name: 'retry_probe' })])
        const tools = await client.listTools()
        expect(tools.map((tool) => tool.name)).toEqual(['retry_probe'])
        await expect(client.callTool(tools[0]!, {})).resolves.toMatchObject({
          content: [{ type: 'text', text: JSON.stringify({ marker: 'remote-mcp-ok', client: 'remote' }) }],
        })
        expect(server.connections()).toBe(1)
        await loaded.setEnabled!('remote', false)
        vi.stubEnv('STRANDS_TEST_MCP_AUTH', 'Bearer expired-again')
        await expect(loaded.setEnabled!('remote', true)).resolves.toContain('403')
        expect(await loaded.list()).toMatchObject([{ state: 'failed', error: expect.stringContaining('403') }])
      } finally {
        await loaded.dispose()
        await server.close()
      }
    }
  )

  it.each([
    { transport: 'http', cancel: 'disable' },
    { transport: 'http', cancel: 'dispose' },
    { transport: 'sse', cancel: 'disable' },
    { transport: 'sse', cancel: 'dispose' },
  ] as const)(
    'does not reconnect $transport after $cancel during transport creation',
    async ({ transport, cancel }) => {
      const server = await startRemoteMcpServer(transport, {})
      const loaded = await loadMcp({
        paths: [],
        servers: { remote: { url: server.url, type: transport, toolFilters: { allowed: ['^probe$'] } } },
        backgroundConnect: true,
      })
      const client = loaded.clients[0]!
      const toolsChanged = vi.fn()
      client.onToolsChanged = toolsChanged
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
        expect((await client.listTools()).map((tool) => tool.name)).toEqual(['remote_probe'])
        await loaded.setEnabled!('remote', false)
        toolsChanged.mockClear()

        const loadServers = McpClient.loadServers.bind(McpClient)
        const factory = vi.spyOn(McpClient, 'loadServers').mockImplementation(async (...args) => {
          await gate
          return loadServers(...args)
        })
        const reconnecting = loaded.setEnabled!('remote', true)
        await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
        const cancelling = cancel === 'disable' ? loaded.setEnabled!('remote', false) : loaded.dispose()
        release()
        await Promise.all([reconnecting, cancelling])

        expect(await loaded.list(true)).toMatchObject([{ name: 'remote', state: 'disabled' }])
        expect(client.connectionState).toBe('disconnected')
        await expect(client.listTools()).resolves.toEqual([])
        expect(server.connections()).toBe(1)
        expect(toolsChanged).not.toHaveBeenCalled()
        expect(factory).toHaveBeenCalledOnce()
      } finally {
        release()
        await loaded.dispose()
        await server.close()
      }
    }
  )

  it.each(['disable', 'dispose'] as const)(
    'completes %s while an SSE stream is waiting for its endpoint',
    async (cancel) => {
      const server = await startRemoteMcpServer('sse', {}, { withholdSseEndpoint: true })
      const loaded = await loadMcp({
        paths: [],
        servers: { remote: { url: server.url, type: 'sse' } },
        backgroundConnect: true,
      })
      const client = loaded.clients[0]!
      const toolsChanged = vi.fn()
      client.onToolsChanged = toolsChanged
      try {
        await vi.waitFor(() => expect(server.pendingSseConnections()).toBe(1))
        expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 0, failed: 0 })
        const finished = vi.fn()
        const cancelling = (cancel === 'disable' ? loaded.setEnabled!('remote', false) : loaded.dispose()).then(
          finished
        )
        await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce(), { timeout: 1000 })
        await cancelling
        await vi.waitFor(() => expect(server.pendingSseConnections()).toBe(0))
        expect(await loaded.list(true)).toMatchObject([{ name: 'remote', state: 'disabled' }])
        expect(client.connectionState).toBe('disconnected')
        await expect(client.listTools()).resolves.toEqual([])
        expect(server.connections()).toBe(0)
        expect(toolsChanged).not.toHaveBeenCalled()
      } finally {
        await server.close()
        void loaded.dispose()
      }
    }
  )

  it('rejects an already-aborted connection without contacting the server', async () => {
    const server = await startRemoteMcpServer('http', {})
    const loaded = await loadMcp({
      paths: [],
      servers: { remote: { url: server.url } },
      backgroundConnect: true,
      disabledServers: ['remote'],
    })
    const reason = new Error('Connection cancelled')
    try {
      await expect(loaded.clients[0]!.connect(false, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
      expect(server.connections()).toBe(0)
    } finally {
      await loaded.dispose()
      await server.close()
    }
  })

  it.each(['abort', 'non-error abort', 'timeout'] as const)(
    'honors a retained tool call %s while a shared SSE connection is pending',
    async (cancellation) => {
      const options = { withholdSseEndpoint: false }
      const server = await startRemoteMcpServer('sse', {}, options)
      const loaded = await loadMcp({
        paths: [],
        servers: { remote: { url: server.url, type: 'sse', tasksConfig: {} } },
        backgroundConnect: true,
      })
      const client = loaded.clients[0]!
      const sharedSettled = vi.fn()
      let shared: Promise<void> | undefined
      try {
        await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
        const tool = (await client.listTools())[0]!
        await client.disconnect()
        options.withholdSseEndpoint = true
        const controller = new AbortController()
        const reason = cancellation === 'non-error abort' ? 'Cancelled' : new Error('Tool call cancelled')
        const settled = vi.fn()
        const call = client
          .callTool(tool, {}, cancellation === 'timeout' ? { timeoutMs: 50 } : { signal: controller.signal })
          .then(settled, settled)
        await vi.waitFor(() => expect(server.pendingSseConnections()).toBe(1))
        shared = client.connect().then(sharedSettled, sharedSettled)
        if (cancellation !== 'timeout') controller.abort(reason)
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 1000 })
        await call
        if (cancellation === 'abort') {
          expect(settled).toHaveBeenCalledWith(reason)
        } else {
          expect(settled.mock.calls[0]![0]).toMatchObject(
            cancellation === 'timeout' ? { code: SdkErrorCode.RequestTimeout } : { name: 'AbortError' }
          )
        }
        expect(sharedSettled).not.toHaveBeenCalled()
        expect(server.pendingSseConnections()).toBe(1)
      } finally {
        await loaded.dispose()
        await shared
        await server.close()
      }
    }
  )

  it('cancels one waiter during transport refresh without cancelling the shared reconnect', async () => {
    const server = await startRemoteMcpServer('http', {})
    const loaded = await loadMcp({
      paths: [],
      servers: { remote: { url: server.url } },
      backgroundConnect: true,
    })
    const client = loaded.clients[0]!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await vi.waitFor(() => expect(loaded.startup?.progress()).toEqual({ total: 1, connected: 1, failed: 0 }))
      await client.disconnect()
      const loadServers = McpClient.loadServers.bind(McpClient)
      const factory = vi.spyOn(McpClient, 'loadServers').mockImplementation(async (...args) => {
        await gate
        return loadServers(...args)
      })
      const controller = new AbortController()
      const settled = vi.fn()
      const cancelled = client.connect(false, { signal: controller.signal }).then(settled, settled)
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
      const shared = client.connect()
      const reason = new Error('Stopped waiting for reconnect')
      controller.abort(reason)
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(reason), { timeout: 1000 })
      await cancelled
      expect(server.connections()).toBe(1)
      release()
      await shared
      expect(client.connectionState).toBe('connected')
      expect((await client.listTools()).map((tool) => tool.name)).toContain('remote_probe')
      expect(server.connections()).toBe(2)
    } finally {
      release()
      await loaded.dispose()
      await server.close()
    }
  })

  it('expands environment references in authored stdio tool filters', async () => {
    vi.stubEnv('STRANDS_TEST_ALLOWED_TOOL', '^read_')
    const loaded = await loadMcp({
      paths: [],
      servers: {
        local: {
          command: 'node',
          toolFilters: { allowed: ['${env:STRANDS_TEST_ALLOWED_TOOL}'] },
        },
      },
    })
    expect(stdioClientConfigs).toMatchObject([{ toolFilters: { allowed: [/^read_/] } }])
    await loaded.dispose()
  })

  it.each([
    [null, '"auth" must be an object'],
    [{ clientSecret: 'secret' }, '"auth.clientId" must be a string'],
    [{ clientId: 'client', clientSecret: 42 }, '"auth.clientSecret" must be a string'],
    [{ clientId: 'client', clientSecret: 'secret', scopes: 'read' }, '"auth.scopes" must be an array of strings'],
  ])('rejects malformed OAuth configuration %j', async (auth, error) => {
    await expect(
      readMcpDefinitions({
        paths: [],
        servers: { remote: { url: 'https://example.com/mcp', auth } },
      })
    ).rejects.toThrow(error as string)
  })

  it('ignores unrelated fields in a known application settings file without MCP configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-app-settings-'))
    const settingsDirectory = join(directory, '.gemini')
    const path = join(settingsDirectory, 'settings.json')
    await mkdir(settingsDirectory, { recursive: true })
    await writeFile(path, JSON.stringify({ hooks: { beforeTool: [] }, general: { previewFeatures: true } }))
    vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])

    try {
      const loaded = await loadMcp({ paths: [path] })
      expect(await loaded.list()).toEqual([])
      await loaded.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("namespaces each server's tools by server name unless the config sets a prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-prefix-'))
    const path = join(directory, 'mcp.json')
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          'ai-community-slack-mcp': { command: 'slack-mcp' },
          'awslabs.aws-docs': { command: 'docs-mcp' },
          chorus: { command: 'chorus-mcp', prefix: 'docs' },
          bare: { command: 'bare-mcp', prefix: '' },
          templated: { command: 'templated-mcp', prefix: '${STRANDS_CLI_TEST_MCP_PREFIX}' },
        },
      })
    )
    vi.stubEnv('STRANDS_CLI_TEST_MCP_PREFIX', 'expanded')
    try {
      const loaded = await loadMcp({ paths: [path] })
      expect(stdioClientConfigs.map((config) => config.prefix)).toEqual([
        'ai-community-slack-mcp',
        'awslabs_aws-docs', // characters a tool name can't carry become `_`, as in the SDK
        'docs',
        '',
        'expanded',
      ])
      // Each client is named by its config key so the library's subagent can tell the servers apart.
      expect(stdioClientConfigs.map((config) => config.applicationName)).toEqual([
        'ai-community-slack-mcp',
        'awslabs.aws-docs',
        'chorus',
        'bare',
        'templated',
      ])
      await loaded.dispose()
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('merges configs in order, disables inherited servers, and disposes loaded clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-'))
    const user = join(directory, 'user.json')
    const project = join(directory, 'project.json')
    const missing = join(directory, 'missing.json')
    await writeFile(
      user,
      JSON.stringify({
        mcpServers: {
          removed: { command: 'old-server' },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
        },
      })
    )
    await writeFile(
      project,
      JSON.stringify({
        mcpServers: {
          removed: { disabled: true },
          local: { command: 'node', args: ['server.js'], env: { MODE: 'test' } },
        },
      })
    )

    const disconnect = vi.fn(async () => {})
    const loadServers = vi.spyOn(McpClient, 'loadServers').mockImplementation(async (definitions) =>
      Object.keys(definitions as object).map(
        (name) =>
          ({
            clientName: name,
            connectionState: 'disconnected',
            disconnect,
          }) as unknown as McpClient
      )
    )
    const stdioDisconnect = vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    try {
      const loaded = await loadMcp({ paths: [user, project, missing] })
      expect(loaded.paths).toEqual([user, project, missing])
      expect(loadServers).toHaveBeenCalledTimes(1)
      expect(loadServers).toHaveBeenCalledWith(
        { remote: expect.objectContaining({ url: 'https://example.com/mcp' }) },
        expect.not.objectContaining({ applicationName: expect.anything() }), // named per server by the SDK
        { prefixWithServerName: true }
      )
      expect(stdioTransports).toEqual([
        { command: 'node', args: ['server.js'], env: { MODE: 'test' }, stderr: 'ignore' },
      ])
      expect(await loaded.list()).toMatchObject([
        { name: 'remote', state: 'disconnected' },
        { name: 'local', state: 'disconnected' },
      ])
      await loaded.dispose()
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(stdioDisconnect).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports the path for malformed configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-invalid-'))
    const path = join(directory, 'mcp.json')
    await writeFile(path, '{ nope')
    try {
      await expect(loadMcp({ paths: [path] })).rejects.toThrow(`Invalid MCP configuration at ${path}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('preserves server identity while sanitizing descriptive metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-metadata-'))
    const path = join(directory, 'mcp.json')
    await writeFile(path, JSON.stringify({ mcpServers: { 'lo\u0007cal': { command: 'no\u001b[31mde' } } }))
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    try {
      const loaded = await loadMcp({ paths: [path] })
      expect(await loaded.list()).toEqual([
        {
          name: 'lo\u0007cal',
          transport: 'stdio',
          target: 'node',
          state: 'disconnected',
          source: path,
          canRetry: false,
        },
      ])
      await loaded.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('toggles distinct server identities whose terminal labels are identical', async () => {
    const server = await startRemoteMcpServer('http', {})
    const names = ['lo\u0007cal', 'local']
    let controller: ChatController | undefined
    try {
      const loaded = await loadMcp({
        paths: [],
        servers: Object.fromEntries(names.map((name) => [name, { type: 'http', url: server.url }])),
        backgroundConnect: true,
      })
      const setSettings = vi.fn()
      controller = new ChatController(idleBackend(), { mcp: loaded, setSettings })
      await controller.submit('/mcp')
      const rows = controller.getSnapshot().panel!.rows
      expect(rows.map((row) => row.label)).toEqual(['local', 'local'])
      expect(rows.map((row) => row.value)).toEqual(names.map((name) => `mcp:toggle:${encodeURIComponent(name)}`))

      for (const [index, name] of names.entries()) {
        const disabling = controller.activatePanelRow(rows[index]!)
        expect(controller.getSnapshot().composerStatus).toBe('Disconnecting local...')
        await disabling
        expect(await loaded.list()).toMatchObject(
          names.map((candidate) => ({ name: candidate, state: candidate === name ? 'disabled' : 'connected' }))
        )
        expect(setSettings).toHaveBeenLastCalledWith({ disabledMcpServers: [name] })

        const enabling = controller.activatePanelRow(rows[index]!)
        expect(controller.getSnapshot().composerStatus).toBe('Connecting local...')
        await enabling
        expect(await loaded.list()).toMatchObject(names.map((candidate) => ({ name: candidate, state: 'connected' })))
        expect(setSettings).toHaveBeenLastCalledWith({ disabledMcpServers: [] })
      }
    } finally {
      await controller?.dispose()
      await server.close()
    }
  })

  it('reads Gemini settings with comments and its httpUrl/url transport spelling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-gemini-'))
    const path = join(directory, '.gemini', 'settings.json')
    await mkdir(join(directory, '.gemini'), { recursive: true })
    await writeFile(
      path,
      [
        '{',
        '  // Gemini CLI allows comments here.',
        '  "mcpServers": {',
        '    "docs": { "httpUrl": "https://example.com/mcp", "includeTools": ["search"] },',
        '    "events": { "url": "https://example.com/sse" }, /* legacy SSE */',
        '    "local": { "command": "node", "args": ["server.js"], "excludeTools": ["rm"] }',
        '  }',
        '}',
      ].join('\n')
    )
    vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    try {
      const loaded = await loadMcp({ paths: [path] })
      expect(McpClient.loadServers).toHaveBeenCalledWith(
        {
          docs: {
            url: 'https://example.com/mcp',
            transport: 'streamable-http',
            continueOnError: true,
            toolFilters: { allowed: ['^search$'] },
          },
        },
        expect.not.objectContaining({ applicationName: expect.anything() }), // named per server by the SDK
        { prefixWithServerName: true }
      )
      expect(McpClient.loadServers).toHaveBeenCalledWith(
        {
          events: { url: 'https://example.com/sse', transport: 'sse', continueOnError: true },
        },
        expect.not.objectContaining({ applicationName: expect.anything() }), // named per server by the SDK
        { prefixWithServerName: true }
      )
      expect(stdioClientConfigs).toMatchObject([{ continueOnError: true, toolFilters: { rejected: [/^rm$/] } }])
      expect(loaded.warnings).toEqual([])
      await loaded.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("skips what it cannot read in another tool's configuration and reports it instead of failing", async () => {
    const directory = await temporaryDirectory('strands-mcp-foreign-')
    const claude = join(directory, '.claude.json')
    const kiro = join(directory, '.kiro', 'settings', 'mcp.json')
    const codex = join(directory, '.codex', 'config.toml')
    await mkdir(join(directory, '.kiro', 'settings'), { recursive: true })
    await mkdir(join(directory, '.codex'), { recursive: true })
    await writeFile(
      claude,
      JSON.stringify({ mcpServers: { good: { command: 'good-server' }, odd: { transport: 'carrier-pigeon' } } })
    )
    await writeFile(kiro, '{ not json')
    await writeFile(codex, ['[mcp_servers.fine]', 'command = "fine-server"'].join('\n'))
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    const loaded = await loadMcp({ paths: [claude, kiro, codex] })
    expect((await loaded.list()).map((server) => server.name)).toEqual(['good', 'fine'])
    expect(loaded.warnings).toEqual([
      expect.stringContaining(`Invalid MCP configuration at ${claude}: server "odd"`),
      expect.stringContaining(`Invalid MCP configuration at ${kiro}`),
    ])
    await loaded.dispose()
  })

  it('rejects malformed foreign configuration when the path was supplied explicitly', async () => {
    const directory = await temporaryDirectory('strands-mcp-explicit-foreign-')
    const path = join(directory, '.claude.json')
    await writeFile(path, '{ not json')

    await expect(loadMcp({ paths: [path], strictPaths: [path] })).rejects.toThrow(
      `Invalid MCP configuration at ${path}`
    )
  })

  it("honors a Claude project's opt-out of user-scope servers", async () => {
    const directory = await temporaryDirectory('strands-mcp-claude-disabled-')
    const path = join(directory, '.claude.json')
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { kept: { command: 'kept-server' }, muted: { command: 'muted-server' } },
        projects: { [directory]: { disabledMcpServers: ['muted'] } },
      })
    )
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    const loaded = await loadMcp({ cwd: directory, paths: [path] })
    expect((await loaded.list()).map((server) => server.name)).toEqual(['kept'])
    await loaded.dispose()
  })

  it('refuses a project configuration that changes after approval before creating clients', async () => {
    const directory = await temporaryDirectory('strands-mcp-changed-')
    const path = join(directory, 'mcp.json')
    const loadServers = vi.spyOn(McpClient, 'loadServers')
    await writeFile(path, JSON.stringify({ mcpServers: { local: { command: 'first' } } }))

    await expect(loadMcp({ paths: [path], expectedDigests: { [path]: 'stale' } })).rejects.toThrow(
      `MCP configuration changed after workspace approval: ${path}`
    )
    expect(loadServers).not.toHaveBeenCalled()
    expect(stdioTransports).toEqual([])
  })
})
