import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_AGENT_CONFIG, defineHarnessAgentConfig } from '@strands-agents/harness'
import type { Agent } from '@strands-agents/sdk'

import { main, runPlainChat, selectRunMode } from '../src/cli/run.js'
import { agentConfig, parseArgs, shouldPersistModelChanges } from '../src/cli/arguments.js'
import { invocationAgentForRun } from '../src/cli/invocation.js'
import * as mcp from '../src/tui/mcp.js'
import * as mcpConfig from '../src/tui/mcp/config.js'
import { resolveMcpConfig } from '../src/tui/workspace/trust.js'
import { applyProviderEnvironmentValues, CliConfigStore } from '../src/tui/config.js'

describe('agentConfig', () => {
  it('preserves defaults when no flags are supplied', () => {
    const config = agentConfig(parseArgs([]), DEFAULT_HARNESS_AGENT_CONFIG)
    expect(config).toEqual(DEFAULT_HARNESS_AGENT_CONFIG)
  })

  it('maps flags to config', () => {
    const args = parseArgs([
      '--model',
      'bedrock/global.anthropic.claude-sonnet-5',
      '--name',
      'Reviewer',
      '--description',
      'Reviews code',
      '--effort',
      'high',
      '--instructions',
      'be terse',
      '--builtin-tools',
      'read,web_fetch',
      '--builtin-plugins',
      'todos',
      '--context-manager',
      'agentic',
      '--session',
      'off',
      '--session-id',
      'u1',
      '--skills',
      '/tmp/skills',
      '--memory',
      'off',
      '--interventions',
      'ask',
    ])
    const config = agentConfig(args, DEFAULT_HARNESS_AGENT_CONFIG)
    expect(config.name).toBe('Reviewer')
    expect(config.description).toBe('Reviews code')
    expect(config.model).toBe('bedrock/global.anthropic.claude-sonnet-5')
    expect(config.effort).toBe('high')
    expect(config.instructions).toBe('be terse')
    expect(config.builtinTools).toEqual(['read', 'web_fetch'])
    expect(config.builtinPlugins).toEqual(['todos'])
    expect(config.contextManager).toBe('agentic')
    // `--session off` wins over the id flag.
    expect(config.session).toBe(false)
    expect(config.skills).toEqual(['/tmp/skills'])
    expect(config.memory).toBe(false)
    expect(config.interventions).toBe('ask')
  })

  it('writes --session-id into session.id, keeping any --set sub-keys', () => {
    expect(agentConfig(parseArgs(['--session-id', 'u1']), DEFAULT_HARNESS_AGENT_CONFIG).session).toEqual({ id: 'u1' })
    expect(
      agentConfig(parseArgs(['--set', 'session.dir="/tmp/s"', '--session-id', 'u1']), DEFAULT_HARNESS_AGENT_CONFIG)
        .session
    ).toEqual({ id: 'u1', dir: '/tmp/s' })
    expect(
      agentConfig(parseArgs(['--session-id', 'u1']), { ...DEFAULT_HARNESS_AGENT_CONFIG, session: false }).session
    ).toBe(false)
    expect(
      agentConfig(parseArgs(['--session', 'on', '--session-id', 'u1']), DEFAULT_HARNESS_AGENT_CONFIG).session
    ).toEqual({ id: 'u1' })
  })

  it('maps off sentinels to disabled', () => {
    const config = agentConfig(
      parseArgs(['--effort', 'off', '--context-manager', 'off', '--skills', 'off', '--caching', 'off']),
      DEFAULT_HARNESS_AGENT_CONFIG
    )
    expect(config.effort).toBe('off')
    expect(config.contextManager).toBe(false)
    expect(config.skills).toBe(false)
    expect(config.caching).toBe(false)
  })

  it.each(['--session', '--memory'])('%s accepts on or off and rejects other modes', (flag) => {
    const key = flag.slice(2) as 'session' | 'memory'
    expect(agentConfig(parseArgs([flag, 'on']), { ...DEFAULT_HARNESS_AGENT_CONFIG, [key]: false })[key]).toBe(true)
    expect(agentConfig(parseArgs([flag, 'off']), DEFAULT_HARNESS_AGENT_CONFIG)[key]).toBe(false)
    expect(() => agentConfig(parseArgs([flag, 'auto']), DEFAULT_HARNESS_AGENT_CONFIG)).toThrow(
      `${flag} must be 'on' or 'off'.`
    )
  })

  it.each(['--session', '--memory'])('%s on keeps a configured dir', (flag) => {
    const key = flag.slice(2) as 'session' | 'memory'
    const dir = `/tmp/${key}`
    expect(agentConfig(parseArgs([flag, 'on']), { ...DEFAULT_HARNESS_AGENT_CONFIG, [key]: { dir } })[key]).toEqual({
      dir,
    })
    expect(
      agentConfig(parseArgs(['--set', `${key}.dir="${dir}"`, flag, 'on']), DEFAULT_HARNESS_AGENT_CONFIG)[key]
    ).toEqual({
      dir,
    })
  })

  it.each(['bogus', 'none'])('rejects the effort level %s with the allowed set', (level) => {
    expect(() => agentConfig(parseArgs(['--effort', level]), DEFAULT_HARNESS_AGENT_CONFIG)).toThrow(
      'effort must be one of: auto, off, minimal, low, medium, high, xhigh, max.'
    )
  })

  it('enables caching and sessions when explicit flags override a saved disabled profile', () => {
    const config = agentConfig(parseArgs(['--caching', 'auto', '--session', 'on']), {
      ...DEFAULT_HARNESS_AGENT_CONFIG,
      caching: false,
      session: false,
    })
    expect(config).toMatchObject({ caching: true, session: true })
  })

  it('treats empty builtin lists as none', () => {
    const config = agentConfig(
      parseArgs(['--builtin-tools', '', '--builtin-plugins', '']),
      DEFAULT_HARNESS_AGENT_CONFIG
    )
    expect(config).toMatchObject({ builtinTools: [], builtinPlugins: [] })
  })

  it('passes comma-separated skills entries through unfiltered as an array', () => {
    const config = agentConfig(
      parseArgs(['--skills', '/tmp/a,/tmp/missing,https://example.com/skills']),
      DEFAULT_HARNESS_AGENT_CONFIG
    )
    expect(config.skills).toEqual(['/tmp/a', '/tmp/missing', 'https://example.com/skills'])
  })

  it('accepts supported provider prefixes and rejects unknown providers', () => {
    expect(agentConfig(parseArgs(['--model', 'openai/gpt-5.6-sol']), DEFAULT_HARNESS_AGENT_CONFIG).model).toBe(
      'openai/gpt-5.6-sol'
    )
    expect(() => agentConfig(parseArgs(['--model', 'unknown/model']), DEFAULT_HARNESS_AGENT_CONFIG)).toThrow(
      'supported provider/model'
    )
  })

  it('lets explicit flags override saved profile defaults', () => {
    const config = agentConfig(parseArgs(['--model', 'google/gemini-3.5-flash', '--effort', 'low']), {
      ...DEFAULT_HARNESS_AGENT_CONFIG,
      model: 'openai/gpt-5.6-sol',
      effort: 'high',
      instructions: 'saved profile',
    })

    expect(config).toMatchObject({
      model: 'google/gemini-3.5-flash',
      effort: 'low',
      instructions: 'saved profile',
    })
  })

  it('applies arbitrary portable config fields before dedicated flags', () => {
    const config = agentConfig(
      parseArgs([
        '--set',
        'model="openai/gpt-5-mini"',
        '--set',
        'agentConfig.maxParallelTools=2',
        '--set',
        'builtinTools=["read"]',
        '--model',
        'google/gemini-3.5-flash',
      ]),
      {
        ...DEFAULT_HARNESS_AGENT_CONFIG,
        instructions: 'saved profile',
      }
    )

    expect(config).toMatchObject({
      model: 'google/gemini-3.5-flash',
      builtinTools: ['read'],
      instructions: 'saved profile',
      agentConfig: { maxParallelTools: 2 },
    })
  })

  it('rejects malformed and unknown arbitrary config fields', () => {
    expect(() => agentConfig(parseArgs(['--set', 'missing']), DEFAULT_HARNESS_AGENT_CONFIG)).toThrow(
      '--set expects field=value'
    )
    expect(() => agentConfig(parseArgs(['--set', 'modle=openai/gpt-5-mini']), DEFAULT_HARNESS_AGENT_CONFIG)).toThrow(
      'unknown agent config field'
    )
    // A retired profile key is just another unknown field.
    expect(() => agentConfig(parseArgs(['--set', 'thinking=high']), DEFAULT_HARNESS_AGENT_CONFIG)).toThrow(
      '--set contains an unknown agent config field "thinking".'
    )
  })
})

describe('parseArgs', () => {
  it.each(['--version', '-V'])('prints the CLI package version and exits successfully for %s', async (flag) => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const previousExitCode = process.exitCode
    try {
      await main([flag])
      expect(output).toHaveBeenCalledWith(`${manifest.version}\n`)
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previousExitCode
      output.mockRestore()
    }
  })

  it('captures an explicit prompt and agent project source', () => {
    const args = parseArgs(['--agent', './reviewer/agent.ts', '--prompt', 'review this'])
    expect(args.agent).toBe('./reviewer/agent.ts')
    expect(args.request).toBe('review this')
  })

  it('rejects both positional and explicit prompts', () => {
    expect(() => parseArgs(['--prompt', 'one', 'two'])).toThrow('either positionally or with --prompt')
  })

  it('captures the setup flag', () => {
    expect(parseArgs(['--setup']).setup).toBe(true)
  })

  it('collects repeatable MCP configuration paths', () => {
    const args = parseArgs(['--mcp-config', '/tmp/mcp-a.json', '--mcp-config', '/tmp/mcp-b.json'])
    expect(args.mcpConfig).toEqual(['/tmp/mcp-a.json', '/tmp/mcp-b.json'])
  })
})

describe('retired flag spellings', () => {
  it('rejects a retired flag as an unknown option', () => {
    expect(() => parseArgs(['--thinking', 'low'])).toThrow(/unknown option '--thinking'/u)
  })
})

describe('profile model persistence', () => {
  it.each([
    ['--model', ['--model', 'openai/gpt-5']],
    ['--effort', ['--effort', 'low']],
    ['--set model', ['--set', 'model="openai/gpt-5"']],
    ['--set effort', ['--set', 'effort="low"']],
    ['--agent', ['--agent', './agent.ts']],
  ])('treats %s as a one-run model configuration', (_label, argv) => {
    expect(shouldPersistModelChanges(parseArgs(argv))).toBe(false)
  })

  it('persists model changes for a profile-driven run', () => {
    expect(shouldPersistModelChanges(parseArgs([]))).toBe(true)
  })
})

describe('project invocation', () => {
  it('loads saved-profile packages and explicitly selected environment files', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'strands-cli-profile-')))
    const root = join(directory, 'project')
    const cwd = join(directory, 'launch-directory')
    const packageDirectory = join(root, 'node_modules', 'strands-profile-fixture')
    try {
      await mkdir(cwd)
      await mkdir(packageDirectory, { recursive: true })
      await writeFile(
        join(packageDirectory, 'package.json'),
        JSON.stringify({ name: 'strands-profile-fixture', type: 'module', exports: './tool.js' })
      )
      await writeFile(
        join(packageDirectory, 'tool.js'),
        "export const tool = { name: 'project-tool', description: process.env.ANTHROPIC_API_KEY }\n"
      )
      await writeFile(
        join(root, '.env'),
        'OPENAI_API_KEY=project-key\nANTHROPIC_API_KEY=project-key\nSTRANDS_CLI_PROJECT_TOKEN=project-token'
      )
      await writeFile(join(root, '.env.local'), 'ANTHROPIC_API_KEY=local-key')
      await writeFile(join(cwd, '.env'), 'ANTHROPIC_API_KEY=cwd-key\nGEMINI_API_KEY=cwd-fallback-key')
      vi.stubEnv('OPENAI_API_KEY', 'process-key')
      vi.stubEnv('ANTHROPIC_API_KEY', undefined)
      vi.stubEnv('GEMINI_API_KEY', undefined)
      vi.stubEnv('STRANDS_CLI_PROJECT_TOKEN', undefined)
      const path = join(directory, 'config.json')
      const config = await CliConfigStore.load(path)
      await config.saveSetup({
        providers: ['bedrock'],
        profile: defineHarnessAgentConfig({
          skills: false,
          tools: [{ kind: 'tool', module: 'strands-profile-fixture', export: 'tool' }],
        }),
        profileBaseDir: root,
        permissionMode: 'default',
        providerEnvironment: {},
      })
      const servers = {
        private: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${STRANDS_CLI_PROJECT_TOKEN}' } },
      }
      const args = parseArgs(['--set', `mcpServers=${JSON.stringify(servers)}`])

      const reloaded = await CliConfigStore.load(path)
      reloaded.useEnvironmentFiles([join(root, '.env'), join(root, '.env.local')])
      const invocation = await invocationAgentForRun(args, reloaded, cwd)

      expect(invocation.options.tools).toEqual([{ name: 'project-tool', description: 'local-key' }])
      expect(invocation.options.mcpServers).toEqual({
        private: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer project-token' } },
      })
      expect(invocation.options.printer).toBe(false)
      expect(process.env.OPENAI_API_KEY).toBe('process-key')
      expect(process.env.GEMINI_API_KEY).toBeUndefined()
    } finally {
      applyProviderEnvironmentValues({})
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('ignores implicit dotenv files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-cli-profile-'))
    try {
      await writeFile(join(directory, '.env'), 'OPENAI_API_KEY=cwd-key')
      vi.stubEnv('OPENAI_API_KEY', undefined)

      const config = CliConfigStore.memory()
      const invocation = await invocationAgentForRun(parseArgs([]), config, directory)

      expect(invocation.options.skills).toBe(true)
      expect(process.env.OPENAI_API_KEY).toBeUndefined()
    } finally {
      applyProviderEnvironmentValues({})
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('selectRunMode', () => {
  it.each([
    { argv: [], stdinIsTty: true, stdoutIsTty: true, expected: 'ink' },
    { argv: ['hello'], stdinIsTty: true, stdoutIsTty: true, expected: 'ink' },
    { argv: ['--print', 'hello'], stdinIsTty: true, stdoutIsTty: true, expected: 'print' },
    { argv: ['hello'], stdinIsTty: false, stdoutIsTty: true, expected: 'print' },
    { argv: ['hello'], stdinIsTty: true, stdoutIsTty: false, expected: 'plain' },
    { argv: ['hello'], stdinIsTty: false, stdoutIsTty: false, expected: 'print' },
    { argv: ['--acp-server'], stdinIsTty: true, stdoutIsTty: true, expected: 'acp' },
  ])(
    'routes $argv with stdin TTY=$stdinIsTty stdout TTY=$stdoutIsTty to $expected',
    ({ argv, stdinIsTty, stdoutIsTty, expected }) => {
      expect(selectRunMode(parseArgs(argv), { stdinIsTty, stdoutIsTty })).toBe(expected)
    }
  )
})

describe('plain interactive mode', () => {
  it('runs a positional request first and continues reading chat turns', async () => {
    const sent: string[] = []
    const agent = {
      addHook() {},
      async *stream(message: string) {
        sent.push(message)
        yield {
          type: 'modelStreamUpdateEvent',
          event: {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: `reply to ${message}` },
          },
        }
        return undefined
      },
    } as unknown as Agent
    const lines = ['follow up', 'exit']
    const prompt = {
      question: vi.fn(async () => lines.shift() ?? 'exit'),
      close: vi.fn(),
    }
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    try {
      await runPlainChat(agent, 'first request', prompt)
    } finally {
      output.mockRestore()
    }

    expect(sent).toEqual(['first request', 'follow up'])
    expect(prompt.question).toHaveBeenCalledTimes(2)
    expect(prompt.close).toHaveBeenCalledOnce()
  })
})

describe('interactive MCP trust routing', () => {
  it.each([false, true])('keeps an explicit discovered file last with project trust %s', async (trusted) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-cli-mcp-precedence-'))
    const explicit = join(directory, '.claude.json')
    const discovered = join(directory, 'mcp.json')
    const project = join(directory, '.mcp.json')
    const discovery = vi.spyOn(mcpConfig, 'defaultMcpPaths').mockReturnValue([explicit, discovered])
    try {
      await writeFile(explicit, JSON.stringify({ mcpServers: { shared: { command: 'explicit-server' } } }))
      await writeFile(discovered, JSON.stringify({ mcpServers: { shared: { command: 'discovered-server' } } }))
      await writeFile(project, JSON.stringify({ mcpServers: { shared: { command: 'project-server' } } }))

      const config = await resolveMcpConfig([explicit], {
        cwd: directory,
        confirm: async () => trusted,
        trustPath: join(directory, 'trusted.json'),
      })
      const canonicalExplicit = await realpath(explicit)
      expect(config.paths.at(-1)).toBe(canonicalExplicit)
      expect(config.paths.filter((path) => path === canonicalExplicit)).toHaveLength(1)
      expect(config.strictPaths).toEqual([canonicalExplicit])

      const loaded = await mcp.loadMcp({ cwd: directory, ...config })
      expect(await loaded.list()).toContainEqual(expect.objectContaining({ name: 'shared', target: 'explicit-server' }))
      await loaded.dispose()
    } finally {
      discovery.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { source: 'settings', discovery: false },
    { source: 'environment', discovery: undefined },
  ])('disables implicit MCP discovery through $source while retaining explicit config', async ({ discovery }) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-cli-no-mcp-discovery-'))
    const project = join(directory, '.mcp.json')
    const explicit = join(directory, 'explicit.json')
    await writeFile(project, JSON.stringify({ mcpServers: { project: { command: 'node' } } }))
    await writeFile(explicit, JSON.stringify({ mcpServers: { explicit: { command: 'node' } } }))
    vi.stubEnv('STRANDS_CLI_MCP_DISCOVERY', discovery === undefined ? 'off' : undefined)
    try {
      const config = await resolveMcpConfig([explicit], {
        cwd: directory,
        trustPath: join(directory, 'trusted.json'),
        ...(discovery === undefined ? {} : { discovery }),
      })

      expect(config.paths).toEqual([await realpath(explicit)])
      expect(config.strictPaths).toEqual([await realpath(explicit)])
      expect(config.expectedDigests).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('excludes unapproved project config and remembers an approved fingerprint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-cli-trust-'))
    const project = join(directory, '.mcp.json')
    const trustPath = join(directory, 'trusted.json')
    await writeFile(project, JSON.stringify({ mcpServers: { local: { command: 'node' } } }))
    try {
      const canonicalProject = join(await realpath(directory), '.mcp.json')
      const reject = { confirm: vi.fn(async () => false) }
      const rejected = await resolveMcpConfig([], { cwd: directory, confirm: reject.confirm, trustPath })
      expect(rejected.paths).not.toContain(canonicalProject)
      expect(reject.confirm).toHaveBeenCalledOnce()

      const approve = { confirm: async () => true }
      const approved = await resolveMcpConfig([], { cwd: directory, confirm: approve.confirm, trustPath })
      expect(approved.paths).toContain(canonicalProject)
      expect(approved.expectedDigests?.[canonicalProject]).toMatch(/^[a-f0-9]{64}$/)

      const remembered = { confirm: vi.fn() }
      const loaded = await resolveMcpConfig([], { cwd: directory, confirm: remembered.confirm, trustPath })
      expect(loaded.paths).toContain(canonicalProject)
      expect(remembered.confirm).not.toHaveBeenCalled()

      const explicit = join(directory, 'explicit.json')
      await writeFile(explicit, JSON.stringify({ mcpServers: { explicit: { command: 'node' } } }))
      const nonInteractive = await resolveMcpConfig([explicit], { cwd: directory, trustPath })
      expect(nonInteractive.paths.indexOf(canonicalProject)).toBeLessThan(
        nonInteractive.paths.indexOf(await realpath(explicit))
      )
      expect(nonInteractive.expectedDigests?.[canonicalProject]).toBe(approved.expectedDigests?.[canonicalProject])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not load unapproved project configuration in non-interactive modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-cli-untrusted-'))
    const project = join(directory, '.mcp.json')
    await writeFile(project, JSON.stringify({ mcpServers: { local: { command: 'node' } } }))
    try {
      const config = await resolveMcpConfig([], { cwd: directory, trustPath: join(directory, 'trusted.json') })
      expect(config.paths).not.toContain(join(await realpath(directory), '.mcp.json'))
      expect(config.expectedDigests).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('treats an explicitly supplied project config as an intentional opt-in', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-cli-explicit-mcp-'))
    const project = join(directory, '.mcp.json')
    await writeFile(project, JSON.stringify({ mcpServers: { local: { command: 'node' } } }))
    try {
      const canonicalProject = join(await realpath(directory), '.mcp.json')
      const prompt = { confirm: vi.fn() }
      const config = await resolveMcpConfig([project], {
        cwd: directory,
        confirm: prompt.confirm,
        trustPath: join(directory, 'trust.json'),
      })
      expect(config.paths).toContain(canonicalProject)
      expect(config.strictPaths).toEqual([canonicalProject])
      expect(prompt.confirm).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('TUI startup', () => {
  it.each([undefined, 'development', 'production'])(
    'avoids React timing retention while preserving NODE_ENV=%s',
    async (environment) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-cli-production-'))
      const loader = fileURLToPath(new URL('./fixtures/strands-cli-routing-source-loader.mjs', import.meta.url))
      const fixture = fileURLToPath(new URL('./fixtures/strands-cli-production-probe.mjs', import.meta.url))
      await mkdir(join(directory, '.strands', 'cli'), { recursive: true })
      await writeFile(
        join(directory, '.strands', 'cli', 'config.json'),
        JSON.stringify({ settings: { animations: false } })
      )
      const child = spawn(
        process.execPath,
        ['--no-warnings=ExperimentalWarning', '--experimental-loader', loader, fixture],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            NODE_ENV: environment,
            FORCE_COLOR: '1',
          },
          timeout: 10_000,
        }
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      try {
        const [code] = await once(child, 'close')
        expect(code, stderr).toBe(0)
      } finally {
        child.kill()
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000
  )
})

describe('ACP mode routing', () => {
  it.each([
    { argv: ['--acp-server', 'hello'], flag: 'request' },
    { argv: ['--acp-server', '--print'], flag: '--print' },
  ])('rejects the incompatible $flag input', async ({ argv, flag }) => {
    const previousExitCode = process.exitCode
    const errors: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errors.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      process.exitCode = undefined
      await main(argv)
      expect(process.exitCode).toBe(1)
      expect(errors.join('')).toContain(flag)
    } finally {
      write.mockRestore()
      process.exitCode = previousExitCode
    }
  })

  it('answers initialize while the ACP stdin protocol stream remains open', async () => {
    const loader = fileURLToPath(new URL('./fixtures/strands-cli-routing-source-loader.mjs', import.meta.url))
    const entrypoint = fileURLToPath(new URL('../src/main.ts', import.meta.url))
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    const child = spawn(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', '--experimental-loader', loader, entrypoint, '--acp-server'],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const closed = once(child, 'close')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const response = new Promise<string>((resolve, reject) => {
      child.stdout.on('data', () => {
        const newline = stdout.indexOf('\n')
        if (newline >= 0) {
          resolve(stdout.slice(0, newline))
        }
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (!stdout.includes('\n')) {
          reject(new Error(`ACP process closed before responding (${code ?? signal}): ${stderr}`))
        }
      })
    })
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`ACP initialize timed out: ${stderr}`)), 8_000).unref()
    })

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {} },
        }) + '\n'
      )
      const message = JSON.parse(await Promise.race([response, timeout]))
      expect(message).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, agentInfo: { title: 'Strands harness' } },
      })
      expect(child.stdin.destroyed).toBe(false)
    } finally {
      child.stdin.end()
      const exited = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])
      if (!exited) {
        child.kill('SIGKILL')
        await closed
      }
    }
  }, 12_000)
})
