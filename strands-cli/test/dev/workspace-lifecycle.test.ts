import { describe, expect, it, vi } from 'vitest'
import { runInkChat } from '../../src/ui/run.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import type { RequestSetup } from '../../src/agent/configuration.js'
import { CliConfigStore } from '../../src/config/store.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>
type WorkspaceActionHandler = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['onWorkspaceAction']>

const createController = (name: string): ChatController =>
  new ChatController(idleBackend({ name }), {
    runtime: {
      devWorkspace: {
        root: '/workspace',
        entrypoint: '/workspace/agent.ts',
        boundEntrypoint: '/workspace/agent.ts',
        origin: 'created',
      },
    },
  })

const runWithWorkspaceAction = (controller: ChatController, action: WorkspaceActionHandler) => {
  const input = ttyInput()
  const output = ttyOutput(120, 35)
  let request: RequestSetup | undefined
  const factory = vi.fn(async (_signal: AbortSignal, next: RequestSetup) => {
    request = next
    return controller
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
  return {
    factory,
    requested: async (): Promise<RequestSetup> => {
      await vi.waitFor(() => expect(request).toBeDefined())
      return request!
    },
    stop: async (): Promise<void> => {
      input.write('\u0003')
      await running
    },
  }
}

describe('workspace actions', () => {
  it('shouldKeepTheWorkingSessionWhenTheWorkspaceActionEnds', async () => {
    const working = createController('Working agent')
    const dispose = vi.spyOn(working, 'dispose')
    const action = vi.fn<WorkspaceActionHandler>(async () => undefined)
    const run = runWithWorkspaceAction(working, action)
    try {
      ;(await run.requested())({ workspaceAction: 'edit' })

      await vi.waitFor(() => expect(action).toHaveBeenCalledOnce())
      expect(action.mock.calls[0]![0]).toBe('edit')
      expect(dispose).not.toHaveBeenCalled()
      expect(run.factory).toHaveBeenCalledOnce()
    } finally {
      await run.stop()
    }
  })

  it('shouldShowTheErrorInTheWorkingSessionWhenTheWorkspaceActionFails', async () => {
    const working = createController('Working agent')
    const show = vi.spyOn(working, 'showError')
    const run = runWithWorkspaceAction(working, async () => {
      throw new Error('Workspace editing is unavailable in this terminal.')
    })
    try {
      ;(await run.requested())({ workspaceAction: 'edit' })

      await vi.waitFor(() =>
        expect(show).toHaveBeenCalledWith('Workspace unchanged', 'Workspace editing is unavailable in this terminal.')
      )
      expect(run.factory).toHaveBeenCalledOnce()
    } finally {
      await run.stop()
    }
  })
})
