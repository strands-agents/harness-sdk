import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BeforeToolCallEvent, JSONValue } from '@strands-agents/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CedarPermissions, ToolPermissionBroker } from '../src/tui/permissions/policy.js'
import { CliConfigStore } from '../src/tui/config.js'
import { createDiffPreview } from '../src/tui/permissions/file-change-preview.js'
import { formatPermissionPanelBody } from '../src/tui/chat/panels.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CedarPermissions', () => {
  it('shows control characters as escapes without hiding any executed input', async () => {
    const broker = new ToolPermissionBroker()
    const command = 'echo start;\u001b]HIDDEN_COMMAND\u0007\t\u202eEND\u009dHIDDEN_C1\u009c'
    broker.subscribe((request) => {
      if (!request) return
      expect(request.input).toEqual({ command })
      const body = formatPermissionPanelBody(request)
      expect(sanitizeTerminalText(body)).toBe(body)
      expect(body).toContain('HIDDEN_COMMAND')
      expect(body).toContain('\\u001b')
      expect(body).toContain('\\u0007\\t\\u202eEND')
      expect(body).toContain('\\u009dHIDDEN_C1\\u009c')
      broker.respond(request.id, 'deny')
    })
    await expect(broker.request('shell', { command })).resolves.toEqual({ type: 'deny' })
  })

  it.each(['deny', 'deny-always'])('allows configuration drafting and reports an apply %s', async (denial) => {
    const broker = new ToolPermissionBroker()
    const preview = createDiffPreview('config.json', 'default', 'bypassPermissions')
    const configurationDenied = vi.fn()
    const permissions = new CedarPermissions({
      broker,
      config: CliConfigStore.memory(),
      cwd: process.cwd(),
      configurationPreview: () => preview,
      configurationDenied,
    })
    const requests: string[] = []
    broker.subscribe((request) => {
      if (request) {
        requests.push(request.toolName)
        expect(request.diff).toEqual(preview)
        expect(request.action).toBe('apply')
        expect(request.options.map((option) => option.id)).toEqual([
          'allow-once',
          'allow-always',
          'deny',
          'deny-always',
        ])
        expect(request.scopes?.map((scope) => scope.rule)).toEqual(['strands_config(apply)', 'strands_config'])
        expect(broker.respond(request.id, 'allow-always', 'shell')).toBe(false)
        broker.respond(request.id, requests.length === 1 ? 'allow-once' : denial)
      }
    })
    for (const action of ['inspect', 'models', 'update']) {
      await expect(permissions.beforeToolCall(toolEvent('strands_config', { action }))).resolves.toMatchObject({
        type: 'proceed',
      })
    }
    await expect(
      permissions.beforeToolCall(toolEvent('strands_config', { action: 'apply', revision: 1 }))
    ).resolves.toMatchObject({ type: 'proceed' })
    expect(configurationDenied).not.toHaveBeenCalled()
    await expect(
      permissions.beforeToolCall(toolEvent('strands_config', { action: 'apply', revision: 2 }))
    ).resolves.toMatchObject({ type: 'deny' })
    expect(requests).toEqual(['strands_config', 'strands_config'])
    expect(configurationDenied).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('reports configuration applies denied by saved rules before bypass mode', async () => {
    const broker = new ToolPermissionBroker()
    const prompted = vi.fn()
    const configurationDenied = vi.fn()
    broker.subscribe(prompted)
    const permissions = new CedarPermissions({
      broker,
      config: CliConfigStore.memory({ mode: 'bypassPermissions', deny: ['strands_config(apply)'] }),
      cwd: process.cwd(),
      configurationDenied,
    })

    await expect(
      permissions.beforeToolCall(toolEvent('strands_config', { action: 'apply', revision: 3 }))
    ).resolves.toMatchObject({ type: 'deny' })
    expect(configurationDenied).toHaveBeenCalledExactlyOnceWith(3)
    expect(prompted).not.toHaveBeenCalled()
  })

  it('does not report other denied actions or invalid configuration revisions as denied drafts', async () => {
    const configurationDenied = vi.fn()
    const permissions = new CedarPermissions({
      broker: new ToolPermissionBroker(),
      config: CliConfigStore.memory({ deny: ['strands_config', 'shell'] }),
      cwd: process.cwd(),
      configurationDenied,
    })
    const calls = [
      toolEvent('strands_config', { action: 'update', revision: 1 }),
      toolEvent('strands_config', { action: 'apply' }),
      toolEvent('strands_config', { action: 'apply', revision: null }),
      toolEvent('strands_config', { action: 'apply', revision: '1' }),
      toolEvent('strands_config', { action: 'apply', revision: 1.5 }),
      toolEvent('shell', { action: 'apply', revision: 1 }),
    ]
    for (const call of calls) {
      await expect(permissions.beforeToolCall(call)).resolves.toMatchObject({ type: 'deny' })
    }
    expect(configurationDenied).not.toHaveBeenCalled()
  })

  it('lets the user trust configuration writes so the agent can apply its own changes', async () => {
    const broker = new ToolPermissionBroker()
    const prompted = vi.fn()
    broker.subscribe(prompted)
    const permissions = new CedarPermissions({
      broker,
      config: CliConfigStore.memory({ allow: ['strands_config(apply)'] }),
      cwd: process.cwd(),
    })

    await expect(permissions.beforeToolCall(toolEvent('strands_config', { action: 'apply' }))).resolves.toMatchObject({
      type: 'proceed',
      reason: expect.stringContaining('always allowed'),
    })
    expect(prompted).not.toHaveBeenCalled()
  })

  it('saves the chosen scope of a forever choice and applies it to later calls', async () => {
    const workspace = await temporaryWorkspace()
    const config = CliConfigStore.memory()
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, config, cwd: workspace })
    const requests: string[] = []
    broker.subscribe((request) => {
      if (!request) return
      requests.push(request.action ?? '')
      expect(request.scopes?.map((scope) => scope.rule)).toContain('shell(git push *)')
      broker.respond(request.id, 'allow-always', 'shell(git push *)')
    })

    await expect(
      permissions.beforeToolCall(toolEvent('shell', { command: 'git push origin main' }))
    ).resolves.toMatchObject({ type: 'proceed', reason: expect.stringContaining('shell(git push *)') })
    expect(config.snapshot().permissions.allow).toEqual(['shell(git push *)'])
    await expect(
      permissions.beforeToolCall(toolEvent('shell', { command: 'git push --force origin dev' }))
    ).resolves.toMatchObject({ type: 'proceed', reason: expect.stringContaining('user configuration') })
    expect(requests).toEqual(['git push origin main'])
  })

  it('applies deny-forever rules before allow rules and bypass mode', async () => {
    const workspace = await temporaryWorkspace()
    const config = CliConfigStore.memory({ allow: ['shell'] })
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, config, cwd: workspace })
    await config.denyTool('shell(rm *)')
    await config.setPermissionMode('bypassPermissions')

    await expect(
      permissions.beforeToolCall(toolEvent('shell', { command: 'ls && rm -rf build' }))
    ).resolves.toMatchObject({ type: 'deny', reason: expect.stringContaining('user configuration') })
    await expect(permissions.beforeToolCall(toolEvent('shell', { command: 'ls' }))).resolves.toMatchObject({
      type: 'proceed',
    })
  })

  it('saves a deny-forever choice and denies the call being decided', async () => {
    const workspace = await temporaryWorkspace()
    const config = CliConfigStore.memory()
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, config, cwd: workspace })
    broker.subscribe((request) => {
      if (request) broker.respond(request.id, 'deny-always', 'write')
    })

    await expect(
      permissions.beforeToolCall(toolEvent('write', { path: join(workspace, 'notes.txt'), content: 'x' }))
    ).resolves.toMatchObject({ type: 'deny', reason: expect.stringContaining('user configuration') })
    expect(config.snapshot().permissions.deny).toEqual(['write'])
  })
  it('permits workspace reads and sends writes through interactive approval', async () => {
    const workspace = await temporaryWorkspace()
    await writeFile(join(workspace, 'inside.txt'), 'inside')
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, cwd: workspace })
    const requests: string[] = []
    let preview
    broker.subscribe((request) => {
      if (request) {
        requests.push(request.toolName)
        preview = request.diff
        broker.respond(request.id, 'allow-once')
      }
    })

    await expect(permissions.beforeToolCall(toolEvent('read', { path: 'inside.txt' }))).resolves.toMatchObject({
      type: 'proceed',
    })
    await expect(
      permissions.beforeToolCall(
        toolEvent('write', { path: join(workspace, 'inside.txt'), content: 'changed' }, async () => 'inside')
      )
    ).resolves.toMatchObject({
      type: 'proceed',
      reason: expect.stringContaining('approved once'),
    })
    expect(requests).toEqual(['write'])
    expect(preview).toMatchObject({
      path: join(workspace, 'inside.txt'),
      lines: expect.arrayContaining([expect.objectContaining({ kind: 'add', text: 'changed' })]),
    })
  })

  it.each(['retrieve_context', 'retrieve_offloaded_content'])(
    'permits %s without interactive approval',
    async (toolName) => {
      const broker = new ToolPermissionBroker()
      const permissions = new CedarPermissions({ broker, cwd: await temporaryWorkspace() })
      const requests: string[] = []
      broker.subscribe((request) => {
        if (request) {
          requests.push(request.toolName)
          broker.respond(request.id, 'deny')
        }
      })

      await expect(
        permissions.beforeToolCall(toolEvent(toolName, { reference: 'tooluse-1_0' }))
      ).resolves.toMatchObject({ type: 'proceed' })
      expect(requests).toEqual([])
    }
  )

  it('does not auto-permit reads that escape through paths or symlinks', async () => {
    const workspace = await temporaryWorkspace()
    const outside = await temporaryWorkspace()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(workspace, 'linked.txt'))
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, cwd: workspace })
    const requests: string[] = []
    broker.subscribe((request) => {
      if (request) {
        const input = request.input
        requests.push(
          input !== null && typeof input === 'object' && !Array.isArray(input) ? String(input.path) : 'unknown'
        )
        broker.respond(request.id, 'deny')
      }
    })

    await expect(permissions.beforeToolCall(toolEvent('read', { path: '../outside.txt' }))).resolves.toMatchObject({
      type: 'deny',
    })
    await expect(permissions.beforeToolCall(toolEvent('read', { path: 'linked.txt' }))).resolves.toMatchObject({
      type: 'deny',
    })
    expect(requests).toEqual(['../outside.txt', 'linked.txt'])
  })

  it('serializes concurrent permission prompts', async () => {
    const workspace = await temporaryWorkspace()
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, cwd: workspace })
    const requests: { id: string; tool: string }[] = []
    broker.subscribe((request) => {
      if (request) {
        requests.push({ id: request.id, tool: request.toolName })
      }
    })

    const bash = permissions.beforeToolCall(toolEvent('bash', { command: 'pwd' }))
    const edit = permissions.beforeToolCall(
      toolEvent('edit', { path: 'file.txt', old_str: 'before', new_str: 'after' })
    )
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]?.tool).toBe('bash')
    expect(broker.respond(requests[0]!.id, 'allow-once')).toBe(true)
    await expect(bash).resolves.toMatchObject({ type: 'proceed', reason: expect.stringContaining('once') })

    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.tool).toBe('edit')
    expect(broker.respond(requests[1]!.id, 'deny')).toBe(true)
    await expect(edit).resolves.toMatchObject({ type: 'deny' })
  })

  it('persists always-allowed tools across permission runtimes', async () => {
    const workspace = await temporaryWorkspace()
    const configPath = join(workspace, 'cli.toml')
    const firstConfig = await CliConfigStore.load(configPath)
    const firstBroker = new ToolPermissionBroker()
    const firstPermissions = new CedarPermissions({ broker: firstBroker, config: firstConfig, cwd: workspace })
    firstBroker.subscribe((request) => {
      if (request) {
        firstBroker.respond(request.id, 'allow-always')
      }
    })

    await expect(firstPermissions.beforeToolCall(toolEvent('bash', { command: 'pwd' }))).resolves.toMatchObject({
      type: 'proceed',
      reason: expect.stringContaining('always allowed'),
    })

    const secondConfig = await CliConfigStore.load(configPath)
    const secondBroker = new ToolPermissionBroker()
    const secondPermissions = new CedarPermissions({ broker: secondBroker, config: secondConfig, cwd: workspace })
    const prompted = vi.fn()
    secondBroker.subscribe(prompted)
    await expect(secondPermissions.beforeToolCall(toolEvent('bash', { command: 'git status' }))).resolves.toMatchObject(
      {
        type: 'proceed',
        reason: expect.stringContaining('user configuration'),
      }
    )
    expect(prompted).not.toHaveBeenCalled()
  })

  it('bypasses Cedar prompts only when the user config explicitly enables bypass mode', async () => {
    const workspace = await temporaryWorkspace()
    const config = CliConfigStore.memory({ mode: 'bypassPermissions' })
    const broker = new ToolPermissionBroker()
    const permissions = new CedarPermissions({ broker, config, cwd: workspace })
    const prompted = vi.fn()
    broker.subscribe(prompted)

    await expect(
      permissions.beforeToolCall(toolEvent('write', { path: 'file.txt', content: 'changed' }))
    ).resolves.toMatchObject({
      type: 'proceed',
      reason: expect.stringContaining('bypassed'),
    })
    expect(prompted).not.toHaveBeenCalled()
  })
})

async function temporaryWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strands-permissions-'))
  temporaryDirectories.push(directory)
  return directory
}

function toolEvent(name: string, input: JSONValue, readText?: (path: string) => Promise<string>): BeforeToolCallEvent {
  const state = new Map<string, unknown>()
  return {
    toolUse: { name, input, toolUseId: `${name}-1` },
    invocationState: {},
    agent: {
      appState: {
        get: (key: string): unknown => state.get(key),
        set: (key: string, value: unknown): void => {
          state.set(key, value)
        },
      },
      sandbox: {
        readText: readText ?? vi.fn(async () => ''),
      },
    },
  } as unknown as BeforeToolCallEvent
}
