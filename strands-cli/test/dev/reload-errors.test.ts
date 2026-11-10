import { describe, expect, it, vi } from 'vitest'
import { runInkChat } from '../../src/ui/run.js'
import { ChatController, type ChatControllerApi } from '../../src/ui/chat/controller.js'
import type { ChatConversation } from '../../src/agent/types.js'
import type { RequestSetup } from '../../src/agent/configuration.js'
import { CliConfigStore } from '../../src/config/store.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

describe('dev reload failures', () => {
  it('shouldKeepThePreviousAgentAndSessionWhenNewSourceCannotLoad', async () => {
    const path = '/workspace/agent.ts'
    const snapshot: ChatConversation['snapshot'] = {
      scope: 'agent',
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      data: {},
      appData: {},
    }
    const backend = idleBackend({ captureConversation: async () => snapshot })
    const previous = new ChatController(backend, {
      runtime: {
        devWorkspace: { root: '/workspace', entrypoint: path, origin: 'discovered' },
        session: 'existing-session',
      },
    })
    const showError = vi.spyOn(previous, 'showError')
    const input = ttyInput()
    const output = ttyOutput(110, 35)
    let requestSetup: RequestSetup | undefined
    let attempts = 0
    const running = runInkChat(
      async (_signal, request): Promise<ChatControllerApi> => {
        requestSetup = request
        attempts += 1
        if (attempts > 1) throw new SyntaxError('Unexpected token in agent.ts\n    at source-loader')
        return previous
      },
      {
        input,
        output,
        errorOutput: output,
        config: CliConfigStore.memory(),
        intro: false,
        renderApp: render as RenderApp,
      }
    )
    try {
      await vi.waitFor(() => expect(requestSetup).toBeDefined())
      requestSetup!({ agentProject: path })
      await vi.waitFor(() => expect(showError).toHaveBeenCalledOnce())

      const [title, message] = showError.mock.calls[0]!
      expect(title).toBe('Agent reload failed')
      expect(message).toContain(`Path: ${path}`)
      expect(message).toContain('previous working agent and session are still active')
      expect(message).toContain('save again to retry')
      expect(message).not.toContain('at source-loader')
      expect(previous.getSnapshot().runtime.session).toBe('existing-session')
      expect(backend.dispose).not.toHaveBeenCalled()
      expect(previous.getSnapshot().status).not.toBe('closed')
    } finally {
      input.write('\u0003')
      await running
      showError.mockRestore()
    }
  })
})
