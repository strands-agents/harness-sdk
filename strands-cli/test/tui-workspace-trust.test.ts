import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadMcp } from '../src/tui/mcp.js'
import { inspectWorkspaceMcp, isWorkspaceMcpTrusted, trustWorkspaceMcp } from '../src/tui/workspace/trust.js'

describe('workspace MCP trust', () => {
  it('binds approval to the canonical workspace and exact configuration contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-workspace-trust-'))
    const trustPath = join(directory, 'config', 'trusted.json')
    const configPath = join(directory, '.mcp.json')
    try {
      await expect(inspectWorkspaceMcp(directory)).resolves.toBeUndefined()
      await writeFile(configPath, JSON.stringify({ mcpServers: { local: { command: 'first' } } }))
      const first = await inspectWorkspaceMcp(directory)
      const canonicalDirectory = await realpath(directory)
      expect(first?.paths).toEqual([join(canonicalDirectory, '.mcp.json')])
      expect(await isWorkspaceMcpTrusted(first!, trustPath)).toBe(false)

      await trustWorkspaceMcp(first!, trustPath)
      expect(await isWorkspaceMcpTrusted(first!, trustPath)).toBe(true)
      expect(JSON.parse(await readFile(trustPath, 'utf8'))).toMatchObject({
        version: 1,
        workspaces: { [canonicalDirectory]: first!.fingerprint },
      })

      await writeFile(configPath, JSON.stringify({ mcpServers: { local: { command: 'second' } } }))
      const changed = await inspectWorkspaceMcp(directory)
      expect(await isWorkspaceMcpTrusted(changed!, trustPath)).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fingerprints conventional project files without changing their MCP precedence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-workspace-conventional-'))
    await mkdir(join(directory, '.strands'), { recursive: true })
    await mkdir(join(directory, '.codex'), { recursive: true })
    await mkdir(join(directory, '.gemini'), { recursive: true })
    await mkdir(join(directory, '.kiro', 'settings'), { recursive: true })
    await writeFile(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'node' } } }))
    await writeFile(
      join(directory, '.strands', 'mcp.json'),
      JSON.stringify({ mcpServers: { demo: { command: 'node' } } })
    )
    await writeFile(join(directory, '.codex', 'config.toml'), '[mcp_servers.shared]\ncommand = "codex-server"\n')
    await writeFile(
      join(directory, '.gemini', 'settings.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'gemini-server' } } })
    )
    await writeFile(
      join(directory, '.kiro', 'settings', 'mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'kiro-server' } } })
    )
    try {
      const inspection = await inspectWorkspaceMcp(directory)
      const workspace = await realpath(directory)
      expect(inspection?.paths).toEqual([
        join(workspace, '.mcp.json'),
        join(workspace, '.kiro', 'settings', 'mcp.json'),
        join(workspace, '.gemini', 'settings.json'),
        join(workspace, '.codex', 'config.toml'),
        join(workspace, '.strands', 'mcp.json'),
      ])
      expect(Object.keys(inspection?.digests ?? {})).toEqual(inspection?.paths)

      const loaded = await loadMcp({ cwd: workspace, paths: inspection!.paths })
      expect(await loaded.list()).toContainEqual(expect.objectContaining({ name: 'shared', target: 'codex-server' }))
      await loaded.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
