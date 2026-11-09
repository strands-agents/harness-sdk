import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, URL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'

import * as harness from '@strands-agents/harness'
import { defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'

import { writeAgentProject } from '../src/tui/project/export.js'
import { importAgentProject } from '../src/tui/project/import.js'
import { applyProviderEnvironmentValues, CliConfigStore } from '../src/tui/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  applyProviderEnvironmentValues({})
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('agent projects', () => {
  it.each(['typescript', 'python'] as const)(
    'exports one editable %s agent definition without a runner',
    async (language) => {
      const root = await temporaryDirectory()
      const destination = join(root, 'agent.zip')
      await writeAgentProject(
        defineHarnessAgentConfig({
          name: 'Researcher',
          model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
          instructions: 'Research "this" topic.\nUse sources, not ${interpolation}. 🐸',
          builtinTools: [],
          mcpServers: {
            exa: {
              url: 'https://mcp.exa.ai/mcp',
              transport: 'streamable-http',
              continueOnError: false,
              headers: { Authorization: 'Bearer ${EXA_TOKEN}' },
            },
          },
          session: { id: 'authored-session', dir: './custom-sessions' },
          memory: { dir: './custom-memory' },
        }),
        language,
        [],
        destination
      )

      const entries = await readZipEntries(destination)
      const source = entries.get(language === 'python' ? 'agent/agent.py' : 'agent/agent.ts')!.toString()
      expect(source).toContain('bedrock/anthropic.claude-haiku-4-5-20251001-v1:0')
      expect(source).toContain(language === 'python' ? 'builtin_tools=[]' : 'builtinTools: []')
      expect(source).toContain(language === 'python' ? '"continue_on_error": False' : 'continueOnError: false')
      expect(source).toContain(language === 'python' ? 'os.environ["EXA_TOKEN"]' : "env('EXA_TOKEN')")
      expect(source).toContain('authored-session')
      expect(source).toContain('./custom-sessions')
      expect(source).toContain('./custom-memory')
      expect(source).not.toMatch(/dotenv|loadEnv|load_dotenv/u)
      expect(entries.has('strands.agent.json')).toBe(false)
      expect(entries.has('run.ts')).toBe(false)
      expect(entries.has('run.py')).toBe(false)
      expect(entries.get('README.md')?.toString()).toContain('strands --agent .')
    }
  )

  it.each([false, true])('preserves resolved factory options with custom modules: %s', async (custom) => {
    const root = await temporaryDirectory()
    const destination = join(root, 'agent.zip')
    const module = join(import.meta.dirname, 'fixtures', 'exported-tool.ts')
    const config = defineHarnessAgentConfig({
      instructions: "It's \"quoted\" 'text', newlines\nand ${literal} \\ paths 🐸",
      ...(custom
        ? {
            tools: [{ kind: 'tool' as const, module, files: [module] }],
            effort: 'off' as const,
            contextManager: false,
            builtinTools: { '*': false, web_fetch: { model: 'openai/gpt-5-mini' } },
            builtinPlugins: [],
            memory: false,
            caching: false,
            interventions: 'ask',
            agentConfig: { name: 'overridden', printer: false },
          }
        : {}),
      mcpServers: {
        example: {
          url: 'https://example.com/mcp',
          headers: { Authorization: '${env:EXPORT_SCHEME} ${EXPORT_TOKEN}' },
          disabled: true,
        },
      },
    })
    vi.stubEnv('EXPORT_SCHEME', 'Bearer')
    vi.stubEnv('EXPORT_TOKEN', 'test-value')
    await writeAgentProject(config, 'typescript', [], destination)
    const entries = await readZipEntries(destination)
    for (const [path, contents] of entries) {
      if (!path.startsWith('vendor/')) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), contents)
      }
    }
    const expected = await harnessAgentOptionsFromConfig(
      defineHarnessAgentConfig({
        ...config,
        skills: false,
        tools: custom
          ? [
              {
                kind: 'tool',
                module: './agent/tools/exported-tool.js',
                language: 'typescript',
                files: ['./agent/tools/exported-tool.ts'],
              },
            ]
          : [],
      }),
      root
    )
    const source = entries.get('agent/agent.ts')!.toString()
    const { outputText } = transpileModule(
      source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(join(root, 'agent', 'agent.ts')).href)),
      {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
      }
    )
    const exports: Record<string, unknown> = {}
    const require = createRequire(import.meta.url)
    await runInNewContext(`(async () => { ${outputText} })()`, {
      exports,
      URL,
      process,
      require: (name: string) => {
        if (name === '@strands-agents/harness') {
          return {
            ...harness,
            harnessAgentOptionsFromConfig: (config: harness.HarnessAgentConfig) =>
              harnessAgentOptionsFromConfig(config, root),
            createHarness: (options: Record<string, unknown>) => {
              const effective: Record<string, unknown> = {
                effort: 'auto',
                contextManager: 'auto',
                session: { dir: './.agent/sessions' },
                memory: { dir: './.agent/memory' },
                ...options,
              }
              for (const key of ['session', 'memory']) {
                const value = effective[key]
                if (value && typeof value === 'object' && 'dir' in value && typeof value.dir === 'string') {
                  effective[key] = { ...value, dir: resolve(root, value.dir) }
                }
              }
              return effective
            },
          }
        }
        return require(name)
      },
    })
    expect(exports.agent).toEqual(expected)
  })

  it('loads custom MCP variables only from selected env files and preserves shell values', async () => {
    const root = await temporaryDirectory()
    vi.stubEnv('projectToken', undefined)
    vi.stubEnv('EXISTING_TOKEN', 'process-token')
    await writeFile(join(root, '.env'), 'projectToken=base-token\nEXISTING_TOKEN=file-token')
    await writeFile(join(root, '.env.local'), 'projectToken=local-token')
    await writeFile(
      join(root, 'mcp.json'),
      JSON.stringify({
        mcpServers: { server: { env: { TOKEN: '${env:projectToken}', EXISTING: '${EXISTING_TOKEN}' } } },
      })
    )
    const config = CliConfigStore.memory()
    config.applyProviderEnvironment()
    expect(process.env.projectToken).toBeUndefined()
    config.useEnvironmentFiles([join(root, '.env'), join(root, '.env.local')])
    config.applyProviderEnvironment()

    expect(process.env.projectToken).toBe('local-token')
    expect(process.env.EXISTING_TOKEN).toBe('process-token')
    expect(config.providerEnvironment()).not.toHaveProperty('projectToken')
    await expect(
      harnessAgentOptionsFromConfig(defineHarnessAgentConfig({ mcpServers: './mcp.json' }), root)
    ).resolves.toMatchObject({
      mcpServers: { server: { env: { TOKEN: 'local-token', EXISTING: 'process-token' } } },
    })
  })

  it.each([false, true])('loads source-agent environment only from selected files: %s', async (trusted) => {
    const root = await temporaryDirectory()
    await writeFile(join(root, '.env'), 'projectToken=project-value\nOPENAI_API_KEY=file-key')
    await writeFile(
      join(root, 'agent.ts'),
      `import { createHarness } from '@strands-agents/harness'
export const agent = await createHarness({
  instructions: JSON.stringify({ token: process.env.projectToken ?? null, key: process.env.OPENAI_API_KEY }),
})
`
    )
    const script = `
      const { CliConfigStore } = await import(${JSON.stringify(new URL('../src/tui/config.ts', import.meta.url).href)})
      const { loadTypescriptProject } = await import(${JSON.stringify(new URL('../src/tui/project/typescript.ts', import.meta.url).href)})
      const config = CliConfigStore.memory()
      config.useEnvironmentFiles(${JSON.stringify(trusted ? [join(root, '.env')] : [])})
      const source = await loadTypescriptProject(${JSON.stringify(importAgentProject(root))}, () => config.applyProviderEnvironment())
      console.log(source.options.instructions)
    `
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), '--input-type=module', '-e', script],
      { env: { ...process.env, projectToken: undefined, OPENAI_API_KEY: 'shell-key' } }
    )
    expect(JSON.parse(result.stdout)).toEqual({ token: trusted ? 'project-value' : null, key: 'shell-key' })
  })

  it('writes a runnable archive with declared custom source', async () => {
    const root = await temporaryDirectory()
    const destination = join(root, 'agent.zip')
    const module = join(import.meta.dirname, 'fixtures', 'exported-tool.ts')
    const config = defineHarnessAgentConfig({
      name: 'Portable',
      tools: [{ kind: 'tool', module, language: 'typescript', files: [module] }],
      mcpServers: {
        private: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
          disabled: true,
        },
      },
    })

    await expect(writeAgentProject(config, 'typescript', [], destination)).resolves.toBe(destination)

    const entries = await readZipEntries(destination)
    const source = entries.get('agent/agent.ts')!.toString()
    expect(source).toContain("name: 'Portable'")
    expect(source).toContain('./agent/tools/exported-tool.js')
    expect(source).not.toContain('sessionId:')
    expect(entries.get('agent/tools/exported-tool.ts')?.toString('utf8')).toBe(await readFile(module, 'utf8'))
    expect(entries.has('agent/agent.ts')).toBe(true)
    expect(entries.has('package.json')).toBe(true)
  })

  it.each(['canonical', 'aliased'])('loads edited exported agent code through %s paths', async (pathKind) => {
    const root = await temporaryDirectory()
    const destination = join(root, 'agent.zip')
    const config = defineHarnessAgentConfig({
      name: 'Round Trip',
      effort: 'high',
      builtinTools: ['read'],
      memory: false,
      mcpServers: {
        private: {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
          disabled: true,
        },
      },
    })
    await writeAgentProject(config, 'typescript', [], destination)
    const extracted = join(root, 'extracted')
    for (const [path, contents] of await readZipEntries(destination)) {
      await mkdir(dirname(join(extracted, path)), { recursive: true })
      await writeFile(join(extracted, path), contents)
    }

    const entrypoint = join(extracted, 'agent', 'agent.ts')
    await writeFile(
      entrypoint,
      (await readFile(entrypoint, 'utf8'))
        .replace('Round Trip', 'Renamed Fella')
        .replace("builtinTools: ['read']", "builtinTools: ['write']")
    )
    await writeFile(join(extracted, 'strands.agent.json'), '{broken obsolete snapshot')
    vi.stubEnv('MCP_TOKEN', 'placeholder')
    const project = importAgentProject(extracted)
    if (pathKind === 'aliased') {
      const alias = join(root, 'project-link')
      await symlink(extracted, alias, 'junction')
      project.root = alias
      project.entrypoint = join(alias, 'agent', 'agent.ts')
    }
    const script = `
      const { loadTypescriptProject } = await import(${JSON.stringify(new URL('../src/tui/project/typescript.ts', import.meta.url).href)})
      const source = await loadTypescriptProject(${JSON.stringify(project)})
      const agent = await source.createAgent({ printer: false })
      await agent.initialize()
      console.log(JSON.stringify({ cwd: process.cwd(), name: agent.name, tools: agent.toolRegistry.list().map(tool => tool.name) }))
    `
    const result = await promisify(execFile)(process.execPath, [
      '--import',
      import.meta.resolve('tsx/esm'),
      '--input-type=module',
      '-e',
      script,
    ])
    const loaded = JSON.parse(result.stdout)
    expect(loaded.name).toBe('Renamed Fella')
    expect(loaded.cwd).toBe(process.cwd())
    expect(loaded.tools).toContain('write')
  })

  it.each(['typescript', 'python'] as const)('bundles Cedar policies and skills for %s', async (language) => {
    const root = await temporaryDirectory()
    const policy = join(root, 'policy.cedar')
    const skill = join(root, 'skills', 'review')
    await mkdir(skill, { recursive: true })
    await writeFile(policy, 'permit(principal, action, resource);')
    await writeFile(join(skill, 'skill.md'), '# Review')
    const config = defineHarnessAgentConfig({ interventions: ['ask', policy] })
    const destination = join(root, 'agent.zip')

    await writeAgentProject(config, language, [join(root, 'skills')], destination)
    const entries = await readZipEntries(destination)
    expect(entries.get(language === 'python' ? 'agent/agent.py' : 'agent/agent.ts')!.toString()).toContain(
      './agent/policies/0/policy.cedar'
    )
    expect(entries.get('agent/policies/0/policy.cedar')?.toString()).toBe('permit(principal, action, resource);')
    expect(entries.get('agent/skills/review/skill.md')?.toString()).toBe('# Review')
    const extracted = join(root, 'extracted')
    for (const [path, contents] of entries) {
      await mkdir(dirname(join(extracted, path)), { recursive: true })
      await writeFile(join(extracted, path), contents)
    }
    const imported = importAgentProject(extracted)
    expect(imported.language).toBe(language)
    if (language === 'python') {
      expect([...entries.keys()].some((path) => path.startsWith('vendor/'))).toBe(false)
      expect(entries.get('requirements.txt')?.toString()).toMatch(/^strands-harness~=/m)
      expect(entries.get('requirements.txt')?.toString()).toContain('strands-agents[cedar]')
    } else {
      const dependencies = JSON.parse(entries.get('package.json')!.toString()).dependencies
      expect(dependencies['@cedar-policy/cedar-wasm']).toBeTruthy()
      expect(dependencies['@strands-agents/harness']).toMatch(/^\^\d/)
    }
  })

  it.each([
    ['openai', 'openai', 'openai'],
    ['bedrock-mantle', 'openai', 'openai'],
    ['anthropic', '@anthropic-ai/sdk', 'anthropic'],
    ['google', '@google/genai', 'gemini'],
    ['ollama', 'openai', 'ollama'],
    ['litellm', 'openai', 'litellm'],
  ])('includes provider dependencies for %s in both exports', async (provider, dependency, extra) => {
    const root = await temporaryDirectory()
    const config = defineHarnessAgentConfig({ model: `${provider}/model` })
    const typescript = join(root, 'typescript.zip')
    const python = join(root, 'python.zip')
    await writeAgentProject(config, 'typescript', [], typescript)
    await writeAgentProject(config, 'python', [], python)

    const tsEntries = await readZipEntries(typescript)
    expect(JSON.parse(tsEntries.get('package.json')!.toString()).dependencies[dependency!]).toBeTruthy()
    const pyEntries = await readZipEntries(python)
    expect(pyEntries.get('requirements.txt')?.toString()).toContain(`strands-harness[${extra}]~=`)
  })

  it('includes a production build and points chat users to the Strands CLI', async () => {
    const root = await temporaryDirectory()
    const config = defineHarnessAgentConfig({
      model: 'bedrock/model',
      builtinTools: { web_fetch: { model: 'openai/model' } },
    })
    const destination = join(root, 'agent.zip')
    await writeAgentProject(config, 'typescript', [], destination)
    const entries = await readZipEntries(destination)

    const manifest = JSON.parse(entries.get('package.json')!.toString())
    expect(manifest.dependencies.openai).toBeTruthy()
    expect(manifest.dependencies.dotenv).toBeUndefined()
    expect(manifest.scripts.build).toBe('tsc && node build.mjs')
    expect(manifest.scripts.start).toBeUndefined()
    expect(manifest.scripts.dev).toBeUndefined()
    const tsconfig = JSON.parse(entries.get('tsconfig.json')!.toString())
    expect(tsconfig.compilerOptions.outDir).toBe('dist')
    expect(tsconfig.include).toEqual(['agent/**/*'])
    expect(entries.get('build.mjs')?.toString()).toContain("cpSync('agent', 'dist/agent'")
    expect(entries.get('agent/agent.ts')?.toString()).not.toContain('loadEnv')
    expect(entries.get('.gitignore')?.toString()).toContain('.env.local')
  })

  it.each(['agent.ts', 'agent.py'])('accepts %s as the source entrypoint', async (pointer) => {
    const root = await temporaryDirectory()
    await writeFile(join(root, pointer), '')
    const project = importAgentProject(join(root, pointer))
    expect(project.entrypoint).toBe(join(project.root, pointer))
    expect(project.language).toBe(pointer.endsWith('.py') ? 'python' : 'typescript')
  })

  it.each(['agent.ts', 'agent.py', 'agent/agent.ts', 'agent/agent.mts', 'agent/agent.py'])(
    'loads %s from a ZIP and reuses its extracted project',
    async (entrypoint) => {
      const root = await temporaryDirectory()
      const source = `// ${root}`
      const archive = join(root, 'project.zip')
      await writeFile(
        archive,
        zipSync({ [`project/${entrypoint}`]: strToU8(source), 'project/notes.txt': strToU8('bundled file') })
      )
      const project = importAgentProject(archive)
      temporaryDirectories.push(dirname(project.root))
      expect(project.language).toBe(entrypoint.endsWith('.py') ? 'python' : 'typescript')
      expect(await readFile(project.entrypoint, 'utf8')).toBe(source)
      expect(await readFile(join(project.root, 'notes.txt'), 'utf8')).toBe('bundled file')
      expect(importAgentProject(archive)).toEqual(project)
    }
  )

  it('rejects ZIP entries that escape the project folder', async () => {
    const root = await temporaryDirectory()
    const archive = join(root, 'project.zip')
    await writeFile(archive, zipSync({ 'agent.ts': strToU8(''), '../outside.txt': strToU8('outside') }))
    expect(() => importAgentProject(archive)).toThrow('Unsafe path in agent ZIP')
  })

  it('rejects local executable values without packageable source', async () => {
    const root = await temporaryDirectory()
    const module = join(root, 'tool.ts')
    await writeFile(module, 'export default {}')
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module, language: 'typescript' }],
    })

    await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).rejects.toThrow(
      'must declare a files entry'
    )
  })

  it('rejects cross-language executable values instead of omitting them', async () => {
    const root = await temporaryDirectory()
    const module = join(root, 'tool.ts')
    await writeFile(module, 'export default {}')
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module, language: 'typescript', files: [module] }],
    })

    await expect(writeAgentProject(config, 'python', [], join(root, 'agent.zip'))).rejects.toThrow(
      'Cannot export typescript tool module'
    )
  })

  it.each([
    ['an inline args secret', { mcpServers: { s: { command: 'mcp', args: ['--api-key=sk-live'] } } }, 'args[0]'],
    ['a flag-value args secret', { mcpServers: { s: { command: 'mcp', args: ['--api-key', 'sk-live'] } } }, 'args[1]'],
    [
      'bare-token URL userinfo',
      { mcpServers: { s: { url: 'https://ghp_livetoken123@github.com/mcp' } } },
      'embeds credentials',
    ],
    [
      'an authorization URL query',
      { mcpServers: { s: { url: 'https://api.example.com/mcp?authorization=abc123' } } },
      'url',
    ],
    [
      'a flag-value access-key arg',
      { mcpServers: { s: { command: 'mcp', args: ['--access-key', 'AKIAEXAMPLE'] } } },
      'args[1]',
    ],
    ['a URL query secret', { mcpServers: { s: { url: 'https://example.com/mcp?api_key=sk-live' } } }, 'url'],
    ['an agentConfig secret', { agentConfig: { apiKey: 'sk-live' } }, 'config.agentConfig.apiKey'],
    ['a private-key field', { agentConfig: { privateKey: 'MIIEvQIBADANBg' } }, 'config.agentConfig.privateKey'],
    [
      'a bare token in an innocently named field',
      { agentConfig: { region: 'ghp_abcdefghijklmnopqrstu012345' } },
      'appears to contain a credential',
    ],
    [
      'a bare positional args token',
      { mcpServers: { s: { command: 'mcp', args: ['sk-live-abcdefghijklmnop'] } } },
      'appears to contain a credential',
    ],
    [
      'an agentConfig URL with userinfo',
      { agentConfig: { baseUrl: 'https://svc:sup3rSecretPw@api.example.com' } },
      'embeds credentials',
    ],
    [
      'an inline assignment outside MCP fields',
      { agentConfig: { startup: 'login --password=hunter2' } },
      'config.agentConfig.startup',
    ],
    [
      'an env literal beside a placeholder',
      { mcpServers: { s: { command: 'mcp', env: { API_TOKEN: 'sk-live ${env:UNUSED}' } } } },
      'env.API_TOKEN',
    ],
    [
      'a header literal beside a placeholder',
      { mcpServers: { s: { url: 'https://x/mcp', headers: { Authorization: 'Bearer sk-live ${env:UNUSED}' } } } },
      'headers.Authorization',
    ],
    [
      'URL userinfo beside a placeholder',
      { mcpServers: { s: { url: 'https://user:pass@example.com/mcp?x=${env:Y}' } } },
      'embeds credentials',
    ],
  ])('rejects %s on export', async (_label, overrides, message) => {
    const root = await temporaryDirectory()
    const config = defineHarnessAgentConfig(overrides as Parameters<typeof defineHarnessAgentConfig>[0])

    await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).rejects.toThrow(message)
  })

  it.each([
    ['placeholdered args', { mcpServers: { s: { command: 'mcp', args: ['--api-key', '${MCP_KEY}'] } } }],
    [
      'a mixed-case placeholder',
      { mcpServers: { s: { url: 'https://x/mcp', headers: { Authorization: 'Bearer ${env:my_token}' } } } },
    ],
    ['a secret-named dependency', { dependencies: { typescript: { jsonwebtoken: '^9.0.0' } } }],
    ['a placeholder inside a URL query', { mcpServers: { s: { url: 'https://example.com/mcp?api_key=${MCP_KEY}' } } }],
    ['secret-shaped prose in instructions', { instructions: 'Never print a password: ask the user first.' }],
    [
      'fully placeholdered URL userinfo',
      { mcpServers: { s: { url: 'https://${MCP_USER}:${MCP_PASS}@example.com/mcp' } } },
    ],
  ])('accepts %s on export', async (_label, overrides) => {
    const root = await temporaryDirectory()
    const config = defineHarnessAgentConfig(overrides as Parameters<typeof defineHarnessAgentConfig>[0])

    await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).resolves.toBe(
      join(root, 'agent.zip')
    )
  })

  it('rejects a file-backed MCP config with an embedded secret field on export', async () => {
    const root = await temporaryDirectory()
    const mcpConfig = join(root, 'mcp.json')
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          private: { url: 'https://example.com/mcp', oauth: { clientSecret: 'sk-live' } },
        },
      })
    )
    const config = defineHarnessAgentConfig({ mcpServers: mcpConfig })

    await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).rejects.toThrow(
      'config.mcpServers.private.oauth.clientSecret must use an environment placeholder'
    )
  })

  it('embeds file-backed MCP config accepted by the core library', async () => {
    const root = await temporaryDirectory()
    const mcpConfig = join(root, 'mcp.json')
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          private: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
          },
        },
      })
    )
    const config = defineHarnessAgentConfig({ mcpServers: mcpConfig })

    await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).resolves.toBe(
      join(root, 'agent.zip')
    )
  })

  it.each([['.env'], ['credentials.json'], ['id_ed25519'], ['server.pem'], ['.npmrc']])(
    'rejects a packaged source tree containing %s',
    async (secretName) => {
      const root = await temporaryDirectory()
      const toolDir = join(root, 'tool')
      await mkdir(toolDir)
      const module = join(toolDir, 'exported-tool.ts')
      await writeFile(module, await readFile(join(import.meta.dirname, 'fixtures', 'exported-tool.ts')))
      await writeFile(join(toolDir, secretName), 'not-a-real-secret')
      const config = defineHarnessAgentConfig({
        tools: [{ kind: 'tool', module, language: 'typescript', files: [toolDir] }],
      })

      await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).rejects.toThrow(
        'looks like a credential file'
      )
    }
  )

  it('skips junk directories and keeps env templates in packaged source trees', async () => {
    const root = await temporaryDirectory()
    const toolDir = join(root, 'tool')
    await mkdir(join(toolDir, '.git'), { recursive: true })
    await mkdir(join(toolDir, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(toolDir, '__pycache__'), { recursive: true })
    await writeFile(join(toolDir, '.git', 'config'), '[core]')
    await writeFile(join(toolDir, 'node_modules', 'dep', 'index.js'), 'module.exports = {}')
    await writeFile(join(toolDir, '__pycache__', 'tool.pyc'), '')
    await writeFile(join(toolDir, '.env.example'), 'API_KEY=')
    const module = join(toolDir, 'exported-tool.ts')
    await writeFile(module, await readFile(join(import.meta.dirname, 'fixtures', 'exported-tool.ts')))
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module, language: 'typescript', files: [toolDir] }],
    })
    const destination = join(root, 'agent.zip')

    await expect(writeAgentProject(config, 'typescript', [], destination)).resolves.toBe(destination)

    const entries = await readZipEntries(destination)
    const packaged = [...entries.keys()].filter((path) => path.startsWith('agent/tools/'))
    expect(packaged).toEqual(['agent/tools/.env.example', 'agent/tools/exported-tool.ts'])
  })

  it('rejects a packaged source tree containing a symlink', async () => {
    const root = await temporaryDirectory()
    const outside = join(root, 'outside-file')
    await writeFile(outside, 'reachable only through the link')
    const toolDir = join(root, 'tool')
    await mkdir(toolDir)
    const module = join(toolDir, 'exported-tool.ts')
    await writeFile(module, await readFile(join(import.meta.dirname, 'fixtures', 'exported-tool.ts')))
    await symlink(outside, join(toolDir, 'linked'))
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module, language: 'typescript', files: [toolDir] }],
    })

    await expect(writeAgentProject(config, 'typescript', [], join(root, 'agent.zip'))).rejects.toThrow(
      'cannot contain symbolic links'
    )
  })

  it('rejects a skills directory containing a credential file', async () => {
    const root = await temporaryDirectory()
    const skillDir = join(root, 'skills', 'demo')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Demo')
    await writeFile(join(skillDir, '.env'), 'API_KEY=not-a-real-secret')
    const config = defineHarnessAgentConfig({})

    await expect(
      writeAgentProject(config, 'typescript', [join(root, 'skills')], join(root, 'agent.zip'))
    ).rejects.toThrow('looks like a credential file')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strands-project-'))
  temporaryDirectories.push(directory)
  return directory
}

async function readZipEntries(path: string): Promise<Map<string, Buffer>> {
  return new Map(
    Object.entries(unzipSync(await readFile(path)))
      .filter(([name]) => !name.endsWith('/'))
      .map(([name, contents]) => [name, Buffer.from(contents)])
  )
}
