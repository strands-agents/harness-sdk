import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'
import { McpClient } from '@strands-agents/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultMcpPaths, loadMcp, projectMcpPaths, readMcpDefinitions } from '../src/tui/mcp.js'

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

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>()
  class RecordingStdioClientTransport extends actual.StdioClientTransport {
    constructor(params: ConstructorParameters<typeof actual.StdioClientTransport>[0]) {
      super(params)
      stdioTransports.push(params)
    }
  }
  return { ...actual, StdioClientTransport: RecordingStdioClientTransport }
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  stdioTransports.length = 0
  stdioClientConfigs.length = 0
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('loadMcp', () => {
  it('discovers conventional user and project configuration locations in stable precedence order', () => {
    expect(defaultMcpPaths().map((path) => path.replace(process.env.HOME!, '~'))).toEqual([
      '~/.claude.json',
      '~/.kiro/settings/mcp.json',
      '~/.gemini/settings.json',
      '~/.codex/config.toml',
      '~/.config/strands/mcp.json',
    ])
    expect(projectMcpPaths('/workspace')).toEqual([
      '/workspace/.mcp.json',
      '/workspace/.kiro/settings/mcp.json',
      '/workspace/.gemini/settings.json',
      '/workspace/.codex/config.toml',
      '/workspace/.strands/mcp.json',
    ])
  })

  it('translates Codex TOML servers, auth headers, and tool filters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-codex-'))
    temporaryDirectories.push(directory)
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
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-claude-'))
    temporaryDirectories.push(directory)
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

  it.each(['inline', 'file'] as const)('preserves SDK OAuth credentials from %s configuration', async (source) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-auth-'))
    temporaryDirectories.push(directory)
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
          continueOnError: false,
        },
      },
      expect.not.objectContaining({ applicationName: expect.anything() }),
      { prefixWithServerName: true }
    )
    expect(loaded.paths).toEqual(source === 'file' ? [path] : [])
    await loaded.dispose()
  })

  it.each([undefined, []])('preserves omitted or empty OAuth scopes (%j)', async (scopes) => {
    const auth = { clientId: '', clientSecret: '', ...(scopes === undefined ? {} : { scopes }) }
    const { definitions } = await readMcpDefinitions({
      paths: [],
      servers: { remote: { url: 'https://example.com/mcp', auth } },
    })
    expect(definitions.remote?.auth).toEqual(auth)
  })

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
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-profile-'))
    temporaryDirectories.push(directory)
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
      { name: 'shared', target: 'new-server' },
      { name: 'authored', target: 'node' },
    ])
    await loaded.dispose()
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

  it('reports configured lookup paths even when no file exists there', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-missing-'))
    const path = join(directory, 'mcp.json')
    vi.spyOn(McpClient, 'loadServers').mockResolvedValue([])

    try {
      const loaded = await loadMcp({ paths: [path] })
      expect(loaded.paths).toEqual([path])
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

  it('merges configs in order, supports disabling inherited servers, and exposes ACP definitions', async () => {
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

  it('sanitizes server metadata returned for terminal presentation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-metadata-'))
    const path = join(directory, 'mcp.json')
    await writeFile(path, JSON.stringify({ mcpServers: { 'lo\u0007cal': { command: 'no\u001b[31mde' } } }))
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    try {
      const loaded = await loadMcp({ paths: [path] })
      expect(await loaded.list()).toEqual([
        {
          name: 'local',
          transport: 'stdio',
          target: 'node',
          state: 'disconnected',
        },
      ])
      await loaded.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
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
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-foreign-'))
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
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-explicit-foreign-'))
    temporaryDirectories.push(directory)
    const path = join(directory, '.claude.json')
    await writeFile(path, '{ not json')

    await expect(loadMcp({ paths: [path], strictPaths: [path] })).rejects.toThrow(
      `Invalid MCP configuration at ${path}`
    )
  })

  it("honors a Claude project's opt-out of user-scope servers", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-claude-disabled-'))
    temporaryDirectories.push(directory)
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
    const directory = await mkdtemp(join(tmpdir(), 'strands-mcp-changed-'))
    temporaryDirectories.push(directory)
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
