import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { exportSourceProject, writeAgentProject } from '../src/tui/project/export.js'
import { importAgentProject } from '../src/tui/project/import.js'

const run = promisify(execFile)
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strands-portability-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

it('packages shared local module source once and keeps its relative layout', async () => {
  const source = join(root, 'source')
  await file(join(source, 'tools/extensions.ts'), 'export const tool = {}\nexport const plugin = {}\n')
  await file(join(source, 'shared/label.txt'), 'portable')
  const common = {
    module: './tools/extensions.ts',
    files: ['./tools/extensions.ts', './shared'],
  }
  const archive = join(root, 'agent.zip')
  await writeAgentProject(
    defineHarnessAgentConfig({
      tools: [{ ...common, kind: 'tool', export: 'tool' }],
      plugins: [{ ...common, kind: 'plugin', export: 'plugin' }],
    }),
    'typescript',
    [],
    archive,
    source
  )
  const entries = unzipSync(await readFile(archive))
  expect(entries).toHaveProperty('agent/shared/tools/extensions.ts')
  expect(entries).toHaveProperty('agent/shared/shared/label.txt')
  expect(Object.keys(entries).filter((path) => path.endsWith('extensions.ts'))).toHaveLength(1)
})

it('builds and runs a packaged local tool after its original source is removed', { timeout: 15_000 }, async () => {
  const source = join(root, 'source')
  await file(join(source, 'tools/custom.ts'), "export default {name: 'portable_tool'}\n")
  const archive = join(root, 'agent.zip')
  await writeAgentProject(
    defineHarnessAgentConfig({
      builtinTools: [],
      builtinPlugins: [],
      memory: false,
      session: false,
      contextManager: false,
      tools: [{ kind: 'tool', module: './tools/custom.ts', files: ['./tools/custom.ts'] }],
    }),
    'typescript',
    [],
    archive,
    source
  )
  const project = importAgentProject(archive)
  await rm(source, { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../node_modules'), join(project.root, 'node_modules'), 'junction')
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: project.root })
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const {agent} = await import('./dist/agent/agent.js'); console.log(Boolean(agent.tool.portable_tool))",
    ],
    { cwd: project.root }
  )
  expect(stdout.trim()).toBe('true')
})

it.each(['typescript', 'python'] as const)('rejects unpackaged local %s dependencies', async (language) => {
  const profile = defineHarnessAgentConfig({
    dependencies:
      language === 'typescript'
        ? { typescript: { local: 'file:../local-package' }, python: [] }
        : { typescript: {}, python: ['-r requirements-local.txt'] },
  })
  await expect(writeAgentProject(profile, language, [], join(root, 'agent.zip'))).rejects.toThrow(
    'unpackaged local dependency'
  )
})

it.each(['typescript', 'python'] as const)('rejects credentials in %s dependency URLs', async (language) => {
  const profile = defineHarnessAgentConfig({
    dependencies:
      language === 'typescript'
        ? {
            typescript: { private: 'git+https://audit-user:audit-password@example.invalid/package.git' },
            python: [],
          }
        : {
            typescript: {},
            python: ['private @ https://audit-user:audit-password@example.invalid/package.whl'],
          },
  })
  await expect(writeAgentProject(profile, language, [], join(root, 'agent.zip'))).rejects.toThrow('credentials')
})

it('emits a truthful generated README and no unused instructions file', async () => {
  const archive = join(root, 'agent.zip')
  await writeAgentProject(
    defineHarnessAgentConfig({ name: 'Portable', instructions: 'Embedded instructions' }),
    'typescript',
    [],
    archive
  )
  const entries = unzipSync(await readFile(archive))
  const readme = Buffer.from(entries['README.md']!).toString()
  expect(readme).toContain('Edit `agent/agent.ts`')
  expect(readme).toContain("import { agent } from './dist/agent/agent.js'")
  expect(readme).not.toContain('createAgent(options)')
  expect(readme).not.toContain('agent/instructions.md')
  expect(entries).not.toHaveProperty('agent/instructions.md')
  expect(Buffer.from(entries['agent/agent.ts']!).toString()).toContain("instructions: 'Embedded instructions'")
})

it('preserves executable helpers through export and import', async () => {
  const skill = join(root, 'skill')
  await file(join(skill, 'SKILL.md'), '---\nname: executable\ndescription: Execute\n---\nRun helper.sh.')
  await file(join(skill, 'helper.sh'), '#!/bin/sh\nprintf portable\n')
  await chmod(join(skill, 'helper.sh'), 0o755)
  const archive = join(root, 'agent.zip')
  await writeAgentProject(defineHarnessAgentConfig({}), 'typescript', [skill], archive)
  const project = importAgentProject(archive)
  expect((await stat(join(project.root, 'agent/skills/skill/helper.sh'))).mode & 0o111).toBe(0o111)
})

it('rejects secrets in source-backed MCP configuration during re-export', async () => {
  const source = join(root, 'source')
  await file(join(source, 'agent.ts'), 'export const agent = {}\n')
  await file(
    join(source, 'mcp.json'),
    '{"mcpServers":{"private":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer literal-secret"}}}}'
  )
  await expect(
    exportSourceProject(importAgentProject(source), 'Private', 'typescript', [], join(root, 'private.zip'))
  ).rejects.toThrow('environment placeholder')
})
