import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, JSONValue } from '@strands-agents/sdk'
import { defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'

import { CliConfigStore } from '../../src/tui/config.js'
import { createInteractiveChat } from '../../src/tui/runtime.js'
import type { StrandsChatBackend } from '../../src/tui/strands-backend.js'

const root = await realpath(await mkdtemp(join(tmpdir(), 'strands-self-extensions-')))
const workspace = join(root, 'workspace')
const extensions = join(root, 'extensions')
const skill = join(root, 'skills', 'review')
await Promise.all([mkdir(workspace), mkdir(extensions), mkdir(skill, { recursive: true })])
await writeFile(join(root, 'package.json'), '{"type":"module"}')

async function writeVersion(version: string): Promise<void> {
  await Promise.all([
    writeFile(join(extensions, 'helper.ts'), `export const marker = ${JSON.stringify(version)}\n`),
    writeFile(join(root, 'mcp-marker.txt'), version),
    writeFile(join(skill, 'SKILL.md'), `---\nname: review\ndescription: Review ${version}\n---\n\nUse ${version}.\n`),
  ])
}

await writeVersion('first')
await writeFile(
  join(extensions, 'index.ts'),
  [
    "import { tool } from '@strands-agents/sdk'",
    "import { marker } from './helper.js'",
    "export const custom = tool({ name: 'custom_echo', description: 'Read extension version',",
    "inputSchema: { type: 'object' }, callback: async () => marker })",
    "export const plugin = { name: 'extension-plugin', initAgent() {}, getTools() {",
    "return [tool({ name: 'plugin_echo', description: 'Read plugin version',",
    "inputSchema: { type: 'object' }, callback: async () => marker })] } }",
  ].join('\n')
)
const profile = defineHarnessAgentConfig({
  builtinTools: [],
  builtinPlugins: [],
  tools: [{ kind: 'tool', module: './extensions/index.ts', export: 'custom', files: ['./extensions'] }],
  plugins: [{ kind: 'plugin', module: './extensions/index.ts', export: 'plugin', files: ['./extensions'] }],
  skills: ['./skills'],
  mcpServers: {
    authored: {
      command: process.execPath,
      args: [join(import.meta.dirname, 'self-building-mcp.mjs')],
      continueOnError: false,
    },
  },
  memory: false,
  session: false,
  contextManager: false,
  agentConfig: { backgroundTasks: false },
})
const config = CliConfigStore.memory({}, {}, {}, { profile, profileBaseDir: root })

async function create(): ReturnType<typeof createInteractiveChat> {
  return createInteractiveChat({
    config,
    agentProfile: profile,
    agentOptions: await harnessAgentOptionsFromConfig(profile, root),
    cwd: workspace,
    mcpPaths: [],
    sessionCatalogPath: join(root, 'catalog.json'),
  })
}

async function invokeText(agent: Agent, name: string, input: Record<string, JSONValue> = {}): Promise<string> {
  const result = await agent.tool[name]!.invoke(input, { recordDirectToolCall: false })
  if (result.status !== 'success') throw new Error(JSON.stringify(result.content))
  return result.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('\n')
}

let first: Awaited<ReturnType<typeof create>> | undefined
let second: Awaited<ReturnType<typeof create>> | undefined
try {
  first = await create()
  const original = (first.backend as StrandsChatBackend).agent
  const originalTool = await invokeText(original, 'custom_echo')
  const originalPlugin = await invokeText(original, 'plugin_echo')
  const firstServer = JSON.parse(await invokeText(original, 'authored_probe'))
  await first.submit('/mcp')
  const mcpPanel = first.getSnapshot().panel?.title

  await writeVersion('later')
  second = await create()
  const updated = (second.backend as StrandsChatBackend).agent
  const updatedTool = await invokeText(updated, 'custom_echo')
  const updatedPlugin = await invokeText(updated, 'plugin_echo')
  const updatedSkill = await invokeText(updated, 'skills', { skill_name: 'review' })
  const retainedTool = await invokeText(original, 'custom_echo')
  await first.dispose()
  first = undefined
  let oldMcpStopped = false
  try {
    process.kill(firstServer.pid, 0)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    oldMcpStopped = true
  }
  const nextServer = JSON.parse(await invokeText(updated, 'authored_probe'))
  console.log(
    JSON.stringify({
      originalTool,
      originalPlugin,
      originalMcp: firstServer.marker,
      mcpCwdCorrect: firstServer.cwd === root,
      mcpPanel,
      updatedTool,
      updatedPlugin,
      updatedSkill,
      retainedTool,
      oldMcpStopped,
      updatedMcp: nextServer.marker,
    })
  )
} finally {
  await Promise.all([first?.dispose(), second?.dispose()])
  await rm(root, { recursive: true, force: true })
}
