import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { unzipSync } from 'fflate'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { portableConfig } from '../src/tui/project/configuration.js'
import { writeAgentProject } from '../src/tui/project/export.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strands-mcp-export-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

it.each([
  { command: 'ssh', args: ['host', 'python3', '/srv/mcp/server.py'] },
  { command: 'docker', args: ['run', '--rm', 'image', './app/server.js'] },
])('preserves remote command arguments without packaging host files', async (server) => {
  const profile = defineHarnessAgentConfig({ mcpServers: { remote: server } })
  expect(portableConfig(profile, 'typescript', false, [], root).mcpServers).toEqual({ remote: server })
  const archive = join(root, 'agent.zip')
  await writeAgentProject(profile, 'typescript', [], archive, root)
  expect(Object.keys(unzipSync(await readFile(archive))).some((path) => path.startsWith('agent/mcp/'))).toBe(false)
})

it('packages a local MCP script and declared data while stripping export metadata', async () => {
  await file(join(root, 'server/main.mjs'), "console.log('server')\n")
  await file(join(root, 'mcp-marker.txt'), 'packaged')
  await file(join(root, 'undeclared.txt'), 'local-only')
  const profile = defineHarnessAgentConfig({
    mcpServers: {
      local: {
        command: 'node',
        args: ['./server/main.mjs'],
        files: ['./server', './mcp-marker.txt'],
      },
    },
  })
  const sources: Parameters<typeof portableConfig>[3] = []
  const config = portableConfig(profile, 'typescript', false, sources, root)
  expect(config.mcpServers).toEqual({
    local: {
      command: 'node',
      args: ['./server/main.mjs'],
      cwd: './agent/mcp/local',
    },
  })
  const archive = join(root, 'agent.zip')
  await writeAgentProject(profile, 'typescript', [], archive, root)
  const entries = unzipSync(await readFile(archive))
  expect(Buffer.from(entries['agent/mcp/local/server/main.mjs']!).toString()).toContain('server')
  expect(Buffer.from(entries['agent/mcp/local/mcp-marker.txt']!).toString()).toBe('packaged')
  expect(Object.keys(entries).some((path) => path.endsWith('undeclared.txt'))).toBe(false)
})

it('rejects Python MCP dependencies that a TypeScript export would not install', async () => {
  await file(join(root, 'server.py'), 'from mcp.server import Server\n')
  const profile = defineHarnessAgentConfig({
    mcpServers: { local: { command: 'python3', args: ['./server.py'] } },
    dependencies: { typescript: {}, python: ['mcp>=1'] },
  })
  await expect(writeAgentProject(profile, 'typescript', [], join(root, 'agent.zip'), root)).rejects.toThrow(
    'does not install dependencies.python'
  )
})
