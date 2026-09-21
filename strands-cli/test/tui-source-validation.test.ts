import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'
import { expect, it } from 'vitest'

it('loads ESM authoring folders and import-only packages using exported module semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strands-source-loading-'))
  try {
    const dependency = join(root, 'node_modules', 'import-only')
    await mkdir(dependency, { recursive: true })
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: 'import-only',
        type: 'module',
        exports: { '.': { import: { types: './index.d.mts', default: './index.mjs' } } },
      })
    )
    await writeFile(join(dependency, 'index.d.mts'), 'export const message: string\n')
    await writeFile(join(dependency, 'index.mjs'), "export const message = 'ready'\n")
    await writeFile(
      join(root, 'tool.ts'),
      `import { tool } from '@strands-agents/sdk'
import { message } from 'import-only'
export default tool({ name: 'custom', description: import.meta.url,
inputSchema: { type: 'object' }, callback: async () => message })`
    )
    const config = defineHarnessAgentConfig({ tools: [{ kind: 'tool', module: './tool.ts', files: ['tool.ts'] }] })
    const options = await harnessAgentOptionsFromConfig(config, root)
    expect(options.tools).toEqual([expect.objectContaining({ name: 'custom' })])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it('uses declared file roots without a dot prefix to invalidate loaded source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strands-source-loading-'))
  try {
    await mkdir(join(root, 'extensions'))
    await writeFile(join(root, 'extensions', 'tool.ts'), 'export default { marker: Math.random() }\n')
    await writeFile(join(root, 'extensions', 'helper.ts'), "export const value = 'first'\n")
    const config = defineHarnessAgentConfig({
      tools: [{ kind: 'tool', module: './extensions/tool.ts', files: ['extensions'] }],
    })
    const first = await harnessAgentOptionsFromConfig(config, root)
    await writeFile(join(root, 'extensions', 'helper.ts'), "export const value = 'later'\n")
    const second = await harnessAgentOptionsFromConfig(config, root)
    expect(second.tools?.[0]).not.toBe(first.tools?.[0])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

it('resolves authored MCP working directories against the configuration root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strands-source-loading-'))
  try {
    const config = defineHarnessAgentConfig({
      mcpServers: { local: { command: 'node', cwd: './server' } },
    })
    const options = await harnessAgentOptionsFromConfig(config, root)
    expect((options.mcpServers as Record<string, { cwd: string }>).local?.cwd).toBe(join(root, 'server'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
