import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentResult, FunctionTool, Tool, ToolContext } from '@strands-agents/sdk'
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import {
  defineHarnessAgentConfig,
  harnessAgentOptionsFromConfig,
  type HarnessAgentConfig,
  type HarnessAgentOptions,
  type HarnessModuleReference,
} from '@strands-agents/harness'
import { unzipSync } from 'fflate'

import { CliConfigStore } from '../../src/config/store.js'
import { exportAgentProject } from '../../src/project/export.js'
import { createInteractiveChat } from '../../src/ui/chat/runtime.js'
import { resolveSkillPaths, type SkillPathsOption } from '../../src/agent/skills.js'
import { StrandsChatBackend } from '../../src/agent/backend.js'

import { npmInvocation } from '../../src/terminal/npm.js'
import { importAgentProject } from '../../src/project/import.js'

const run = promisify(execFile)

describe('chat-configured export fields', () => {
  let root: string
  let fixture: CompleteProfileFixture
  let applied: HarnessAgentConfig
  let exported: ExportedProfile

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-chat-export-fields-'))
    vi.stubEnv('AWS_REGION', 'us-east-1')
    fixture = await createCompleteProfileFixture(root)
    applied = await applyCompleteProfileInChat(fixture)
    exported = await exportCompleteProfile(fixture, applied)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('applies the exact profile assembled during chat', () => {
    expect(applied).toEqual(fixture.expected)
  })

  it('excludes CLI settings and the runtime configuration tool from the exported agent', () => {
    expect(exported.source).not.toMatch(/strands_config|permissionMode|allowedTools|frogTheme|mcpDiscovery/)
    expect(Object.keys(exported.entries)).not.toContain('cli.toml')
  })

  it('preserves the configured fields, packaged sources, and dependencies', () => {
    const { source, entries, manifest } = exported
    expect(source).toContain("name: 'Chat configured agent'")
    expect(source).toContain("description: 'Created during chat'")
    expect(source).toContain("instructions: 'Review every field.'")
    expect(source).toContain("model: 'bedrock/chat-base-model'")
    expect(source).toContain('modelModule:')
    expect(source).toContain("effort: 'high'")
    expect(source).toContain('tools:')
    expect(source).toContain('subagents:')
    expect(source).toContain("url: 'https://example.com/mcp'")
    expect(source).toContain('builtinTools: []')
    expect(source).toContain('caching: false')
    expect(source).toContain("contextManager: 'agentic'")
    expect(source).toContain("dir: './state/sessions'")
    expect(source).toContain(fixture.skillUrl)
    expect(entries).toHaveProperty('agent/skills/review/SKILL.md')
    expect(source).toContain("dir: './state/memory'")
    expect(source).toContain('memoryStores:')
    expect(source).toContain('plugins:')
    expect(source).toContain('builtinPlugins: []')
    expect(Object.keys(entries).some((path) => path.endsWith('/approval.cedar'))).toBe(true)
    expect(source).toContain('interventionModules:')
    expect(source).toContain('sandbox:')
    expect(source).toContain('agentConfigModules:')
    expect(manifest.dependencies['@strands-agents/sdk']).toBe('>=1.19.0 <2.0.0')
    expect(source).toContain('checkpointing: true')
  })

  it('builds and loads the generated TypeScript agent', { timeout: 30_000 }, async () => {
    const project = importAgentProject(exported.destination)
    await symlink(resolve(import.meta.dirname, '../../node_modules'), join(project.root, 'node_modules'), 'junction')
    const npm = npmInvocation(['run', 'build'])
    await run(npm.command, npm.args, { cwd: project.root }).catch((error: unknown) => {
      const details = error as { stdout?: string; stderr?: string }
      throw new Error(`Generated project build failed:\n${details.stdout ?? ''}\n${details.stderr ?? ''}`, {
        cause: error,
      })
    })
    const result = await run(
      process.execPath,
      ['--input-type=module', '--eval', "const {agent}=await import('./dist/agent/agent.js'); console.log(agent.name)"],
      { cwd: project.root }
    )
    expect(result.stdout.trim()).toBe('Chat configured agent')
  })
})

interface CompleteProfileFixture {
  expected: HarnessAgentConfig
  root: string
  skillUrl: string
  workspace: string
}

interface ExportedProfile {
  destination: string
  entries: ReturnType<typeof unzipSync>
  manifest: { dependencies: Record<string, string> }
  source: string
}

async function createCompleteProfileFixture(root: string): Promise<CompleteProfileFixture> {
  const workspace = join(root, 'workspace')
  const extension = join(workspace, 'extensions.ts')
  const skillDirectory = join(workspace, 'skills', 'review')
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), '# Review')
  await writeFile(join(workspace, 'approval.cedar'), 'permit(principal, action, resource);')
  await writeFile(
    extension,
    [
      "import { Agent, BedrockModel, InterventionHandler, NullConversationManager, tool } from '@strands-agents/sdk'",
      "import { Sandbox } from '@strands-agents/sdk/sandbox'",
      "export const model = new BedrockModel({ modelId: 'module-model' })",
      "export const customTool = tool({ name: 'custom-tool', description: 'fixture', callback: () => 'ok' })",
      "export const subagent = new Agent({ name: 'subagent', model })",
      "export const plugin = { name: 'fixture-plugin', initAgent() {} }",
      "export const memoryStore = { name: 'fixture-memory', writable: false, search: async () => [] }",
      "class FixtureIntervention extends InterventionHandler { readonly name = 'fixture-intervention' }",
      'export const intervention = new FixtureIntervention()',
      'class FixtureSandbox extends Sandbox {',
      "  async *executeStreaming() { throw new Error('unused') }",
      "  async *executeCodeStreaming() { throw new Error('unused') }",
      '  async readFile() { return new Uint8Array() }',
      '  async writeFile() {}',
      '  async removeFile() {}',
      '  async listFiles() { return [] }',
      '}',
      'export const sandbox = new FixtureSandbox()',
      'export const conversationManager = new NullConversationManager()',
      '',
    ].join('\n')
  )
  const reference = (kind: HarnessModuleReference['kind'], exported: string): HarnessModuleReference => ({
    kind,
    module: './extensions.ts',
    export: exported,
    language: 'typescript',
    files: ['./extensions.ts'],
  })
  const skillUrl = 'https://example.com/remote/SKILL.md'
  const expected = defineHarnessAgentConfig({
    name: 'Chat configured agent',
    description: 'Created during chat',
    instructions: 'Review every field.',
    model: 'bedrock/chat-base-model',
    modelModule: reference('model', 'model'),
    effort: 'high',
    tools: [reference('tool', 'customTool')],
    subagents: [reference('subagent', 'subagent')],
    mcpServers: { docs: { url: 'https://example.com/mcp', disabled: true } },
    builtinTools: [],
    caching: false,
    contextManager: 'agentic',
    session: { id: 'chat-session', dir: './state/sessions' },
    skills: [skillUrl, './skills'],
    memory: { dir: './state/memory' },
    memoryStores: [reference('memory-store', 'memoryStore')],
    plugins: [reference('plugin', 'plugin')],
    builtinPlugins: [],
    interventions: ['ask', './approval.cedar'],
    interventionModules: [reference('intervention', 'intervention')],
    sandbox: reference('sandbox', 'sandbox'),
    agentConfigModules: {
      conversationManager: reference('agent-config', 'conversationManager'),
    },
    dependencies: { typescript: { '@strands-agents/sdk': '>=1.19.0 <2.0.0' }, python: [] },
    agentConfig: { checkpointing: true },
  })
  return { expected, root, skillUrl, workspace }
}

async function applyCompleteProfileInChat(fixture: CompleteProfileFixture): Promise<HarnessAgentConfig> {
  const initial = defineHarnessAgentConfig({
    memory: false,
    session: false,
    skills: false,
    builtinTools: [],
    builtinPlugins: [],
  })
  const config = CliConfigStore.memory(
    {},
    { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false },
    { profile: initial, profileBaseDir: fixture.workspace }
  )
  const requestSetup = vi.fn()
  const controller = await createInteractiveChat({
    config,
    agentProfile: initial,
    agentOptions: { ...(await harnessAgentOptionsFromConfig(initial, fixture.workspace)), backgroundTasks: false },
    buildAgent: testAgent,
    requestSetup,
    cwd: fixture.workspace,
    sessionRoot: join(fixture.root, 'sessions'),
  })
  try {
    const agent = (controller.backend as StrandsChatBackend).agent
    const configuration = agent.tools.find((candidate) => candidate.name === 'strands_config') as FunctionTool
    agent.stream = async function* () {
      yield* []
      const context = { agent } as unknown as ToolContext
      await configuration.invoke({ action: 'update', profile: fixture.expected }, context)
      await configuration.invoke({ action: 'apply', revision: 1 }, context)
      return { stopReason: 'endTurn' } as AgentResult
    }

    await controller.submit('Create this agent and apply every field.')

    expect(requestSetup).toHaveBeenCalledOnce()
    const change = requestSetup.mock.calls[0]![0]
    expect(change.configuration).toBeUndefined()
    return change.profile as HarnessAgentConfig
  } finally {
    await controller.dispose()
  }
}

async function exportCompleteProfile(
  fixture: CompleteProfileFixture,
  profile: HarnessAgentConfig
): Promise<ExportedProfile> {
  const destination = join(fixture.root, 'agent.zip')
  await exportAgentProject(
    profile,
    'typescript',
    resolveSkillPaths(
      (Array.isArray(profile.skills) ? [...profile.skills] : profile.skills) as SkillPathsOption,
      fixture.workspace,
      false
    ),
    fixture.workspace,
    destination
  )
  const entries = unzipSync(await readFile(destination))
  return {
    destination,
    entries,
    source: Buffer.from(entries['agent/agent.ts']!).toString(),
    manifest: JSON.parse(Buffer.from(entries['package.json']!).toString()) as {
      dependencies: Record<string, string>
    },
  }
}

async function testAgent(options: HarnessAgentOptions): Promise<Agent> {
  return new Agent({
    ...(options.name ? { name: options.name } : {}),
    model: new BedrockModel({ modelId: 'test-model' }),
    ...(options.instructions ? { systemPrompt: options.instructions } : {}),
    tools: (options.tools ?? []) as Tool[],
    ...(options.plugins ? { plugins: options.plugins } : {}),
    printer: false,
  })
}
