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
    await expect(broker.request('shell', { command })).resolves.toBe('deny')
  })

  it('allows configuration inspection and drafting while keeping apply behind tool approval', async () => {
    const broker = new ToolPermissionBroker()
    const preview = createDiffPreview('config.json', 'default', 'bypassPermissions')
    const permissions = new CedarPermissions({
      broker,
      config: CliConfigStore.memory({ allow: ['strands_config'] }),
      cwd: process.cwd(),
      configurationPreview: () => preview,
    })
    const requests: string[] = []
    broker.subscribe((request) => {
      if (request) {
        requests.push(request.toolName)
        expect(request.diff).toEqual(preview)
        expect(request.options.map((option) => option.id)).toEqual(['allow-once', 'deny'])
        expect(broker.respond(request.id, 'allow-tool-always')).toBe(false)
        broker.respond(request.id, requests.length === 1 ? 'allow-once' : 'deny')
      }
    })
    for (const action of ['inspect', 'models', 'update', 'reset']) {
      await expect(permissions.beforeToolCall(toolEvent('strands_config', { action }))).resolves.toMatchObject({
        type: 'proceed',
      })
    }
    await expect(permissions.beforeToolCall(toolEvent('strands_config', { action: 'apply' }))).resolves.toMatchObject({
      type: 'proceed',
    })
    await expect(permissions.beforeToolCall(toolEvent('strands_config', { action: 'apply' }))).resolves.toMatchObject({
      type: 'deny',
    })
    expect(requests).toEqual(['strands_config', 'strands_config'])
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
    const configPath = join(workspace, 'config.json')
    const firstConfig = await CliConfigStore.load(configPath)
    const firstBroker = new ToolPermissionBroker()
    const firstPermissions = new CedarPermissions({ broker: firstBroker, config: firstConfig, cwd: workspace })
    firstBroker.subscribe((request) => {
      if (request) {
        firstBroker.respond(request.id, 'allow-tool-always')
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
