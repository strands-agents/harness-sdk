import { createElement } from 'react'
import { expect, it, vi } from 'vitest'

import { ChatController, type ChatBackend, type ChatPermissionRequest } from '../src/tui/chat/controller.js'
import { CliConfigStore } from '../src/tui/config.js'
import { ChatApp } from '../src/tui/view/app.js'
import { idleBackend } from './fixtures/chat-backend.js'
import { captureFrame, render, ttyInput, ttyOutput } from './fixtures/terminal.js'

it('opens /permissions and changes mode without queueing or interrupting the active turn', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const config = CliConfigStore.memory()
  const stream = vi.fn(async function* () {
    yield { type: 'textDelta' as const, text: 'Working' }
    await pending
    return { stopReason: 'endTurn' }
  })
  const cancel = vi.fn()
  const controller = new ChatController(permissionBackend(config, { stream, cancel }), {
    settings: { animations: false },
  })
  const input = ttyInput()
  const output = ttyOutput(100, 30)
  const frame = captureFrame(output)
  const instance = render(createElement(ChatApp, { controller }), {
    stdin: input,
    stdout: output,
    stderr: output,
  })
  const running = controller.submit('Keep working')
  try {
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Working'))
    input.write('/permissions')
    await instance.waitUntilRenderFlush()
    input.write('\r')
    await instance.waitUntilRenderFlush()
    expect(controller.getSnapshot().panel?.kind).toBe('permissions')
    expect(frame().join('\n')).toContain('Bypass')

    input.write('\u001b[C')
    await vi.waitFor(() => expect(controller.getSnapshot().permissionMode).toBe('bypassPermissions'))
    expect(config.snapshot().permissions.mode).toBe('bypassPermissions')
    await instance.waitUntilRenderFlush()
    input.write('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await instance.waitUntilRenderFlush()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'running',
      permissionMode: 'bypassPermissions',
      queuedPrompts: [],
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(stream).toHaveBeenCalledOnce()
    input.write('/permissions default')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('/permissions default▌'))
    input.write('\r')
    await vi.waitFor(() => expect(config.snapshot().permissions.mode).toBe('default'))
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    await controller.submit('/permissions bypass')
    finish()
    await running
    expect(controller.getSnapshot().permissionMode).toBe('bypassPermissions')
  } finally {
    finish()
    await running
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
})

it('opens permission settings while an approval is pending and restores it on dismissal', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const request: ChatPermissionRequest = {
    id: 'permission-1',
    toolName: 'write',
    input: { path: 'example.txt' },
    options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow_once' }],
  }
  const respondPermission = vi.fn(() => true)
  const controller = new ChatController(
    permissionBackend(CliConfigStore.memory(), {
      stream: async function* () {
        yield { type: 'permission', request }
        await pending
        return { stopReason: 'endTurn' }
      },
      respondPermission,
    })
  )
  const running = controller.submit('Write a file')
  await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
  const opening = controller.submit('/permissions')
  try {
    expect(controller.getSnapshot().panel?.kind).toBe('permissions')
    await opening
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    expect(controller.dismissPanel()).toBe(true)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'permission', request })
    expect(respondPermission).not.toHaveBeenCalled()
  } finally {
    finish()
    await Promise.all([running, opening])
    await controller.dispose()
  }
})

function permissionBackend(config: CliConfigStore, overrides: Partial<ChatBackend>): ChatBackend {
  return idleBackend({
    permissionStatus: () => ({
      mode: config.snapshot().permissions.mode,
      allowedTools: [...config.snapshot().permissions.allow],
      deniedTools: [],
      configPath: config.snapshot().path,
    }),
    setPermissionMode: (mode) => config.setPermissionMode(mode),
    allowPermission: (tool) => config.allowTool(tool),
    removeAllowedPermission: (tool) => config.removeAllowedTool(tool),
    ...overrides,
  })
}
