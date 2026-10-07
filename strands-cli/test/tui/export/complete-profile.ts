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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { vi } from 'vitest'

import { CliConfigStore } from '../../../src/tui/config.js'
import { exportAgentProject } from '../../../src/tui/project/export.js'
import { createInteractiveChat } from '../../../src/tui/runtime.js'
import { resolveSkillPaths, type SkillPathsOption } from '../../../src/tui/skills.js'
import { StrandsChatBackend } from '../../../src/tui/strands-backend.js'

export interface CompleteProfileFixture {
  expected: HarnessAgentConfig
  root: string
  skillUrl: string
  workspace: string
}

export interface ExportedProfile {
  destination: string
  entries: ReturnType<typeof unzipSync>
  manifest: { dependencies: Record<string, string> }
  source: string
}

export async function createCompleteProfileFixture(root: string): Promise<CompleteProfileFixture> {
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

export async function applyCompleteProfileInChat(fixture: CompleteProfileFixture): Promise<HarnessAgentConfig> {
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
    sessionCatalogPath: join(fixture.root, 'sessions.json'),
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

    expectSingleCall(requestSetup)
    return requestSetup.mock.calls[0]![0].configuration.profile as HarnessAgentConfig
  } finally {
    await controller.dispose()
  }
}

export async function exportCompleteProfile(
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

function expectSingleCall(mock: ReturnType<typeof vi.fn>): void {
  if (mock.mock.calls.length !== 1) {
    throw new Error(`Expected one setup request, received ${mock.mock.calls.length}`)
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
