import { describe, expect, it, vi } from 'vitest'
import { runInkChat } from '../../src/ui/run.js'
import { ChatController, type ChatControllerApi } from '../../src/ui/chat/controller.js'
import type { RequestSetup } from '../../src/agent/configuration.js'
import type { ChatConversations } from '../../src/agent/types.js'
import { CliConfigStore } from '../../src/config/store.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

const createController = (name: string): ChatController =>
  new ChatController(idleBackend({ name }), {
    runtime: { devWorkspace: { root: '/workspace', entrypoint: '/workspace/agent.ts', origin: 'created' } },
  })

describe('workspace replacement lifecycle', () => {
  it('shouldStopTheOldAgentBeforeApplyingAndStartAFreshAgentAfterSuccess', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const previous = createController('Old agent')
    const replacement = createController('New agent')
    const dispose = vi.spyOn(previous, 'dispose')
    const finish = vi.fn(async () => undefined)
    const rollback = vi.fn(async () => undefined)
    const apply = vi.fn(async () => {
      expect(dispose).toHaveBeenCalledOnce()
    })
    let request: RequestSetup | undefined
    const factory = vi.fn(
      async (
        _signal: AbortSignal,
        next: RequestSetup,
        conversations?: ChatConversations
      ): Promise<ChatControllerApi> => {
        request = next
        expect(conversations).toBeUndefined()
        return factory.mock.calls.length === 1 ? previous : replacement
      }
    )
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      intro: false,
      config: CliConfigStore.memory(),
      renderApp: render as RenderApp,
      onWorkspaceAction: async () => ({ apply, rollback, finish }),
    })
    try {
      await vi.waitFor(() => expect(request).toBeDefined())
      request!({ workspaceAction: 'import' })
      await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
      expect(factory).toHaveBeenCalledTimes(2)
      expect(rollback).not.toHaveBeenCalled()
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it('shouldKeepTheWorkingSessionWhenTheUserCancels', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const previous = createController('Old agent')
    const dispose = vi.spyOn(previous, 'dispose')
    let request: RequestSetup | undefined
    const action = vi.fn(async () => undefined)
    const factory = vi.fn(async (_signal: AbortSignal, next: RequestSetup) => {
      request = next
      return previous
    })
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      intro: false,
      config: CliConfigStore.memory(),
      renderApp: render as RenderApp,
      onWorkspaceAction: action,
    })
    try {
      await vi.waitFor(() => expect(request).toBeDefined())
      request!({ workspaceAction: 'import' })
      await vi.waitFor(() => expect(action).toHaveBeenCalledOnce())
      expect(dispose).not.toHaveBeenCalled()
      expect(factory).toHaveBeenCalledOnce()
    } finally {
      input.write('\u0003')
      await running
    }
  })

  it('shouldRestoreTheOldWorkspaceWhenReplacementStartupFails', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const previous = createController('Old agent')
    const restored = createController('Restored agent')
    const show = vi.spyOn(restored, 'showError')
    const finish = vi.fn(async () => undefined)
    const rollback = vi.fn(async () => undefined)
    let request: RequestSetup | undefined
    let attempt = 0
    const factory = vi.fn(async (_signal: AbortSignal, next: RequestSetup) => {
      request = next
      attempt++
      if (attempt === 2) throw new Error('Replacement could not load')
      return attempt === 1 ? previous : restored
    })
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      intro: false,
      config: CliConfigStore.memory(),
      renderApp: render as RenderApp,
      onWorkspaceAction: async () => ({ apply: async () => undefined, rollback, finish }),
    })
    try {
      await vi.waitFor(() => expect(request).toBeDefined())
      request!({ workspaceAction: 'import' })
      await vi.waitFor(() => expect(show).toHaveBeenCalledWith('Workspace unchanged', 'Replacement could not load'))
      expect(rollback).toHaveBeenCalledOnce()
      expect(finish).not.toHaveBeenCalled()
      expect(factory).toHaveBeenCalledTimes(3)
    } finally {
      input.write('\u0003')
      await running
    }
  })
})
