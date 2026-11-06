import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatController } from '../../src/ui/chat/controller.js'
import { ConversationManager } from '../../src/ui/chat/conversations.js'
import { metadataPlacements } from '../../src/ui/presentation.js'
import * as projectWatch from '../../src/project/watch.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { snapshot } from '../fixtures/chat-snapshot.js'

const devWorkspace = { root: '/workspace', entrypoint: '/workspace/agent.ts', origin: 'cli' }

afterEach(() => vi.restoreAllMocks())

describe('dev session identity', () => {
  it('shouldIdentifyWorkspaceSettingsWhenADevControllerStarts', async () => {
    const controller = new ChatController(idleBackend({ name: 'Local harness' }), { runtime: { devWorkspace } })
    try {
      expect(controller.getSnapshot().notices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining('Model, tools, and instructions come from this workspace'),
          }),
        ])
      )
      expect(controller.getSnapshot().notices[0]?.text).toContain('/workspace/agent.ts')
    } finally {
      await controller.dispose()
    }
  })

  it.each([true, false])('shouldShowRealWatchStatusWhenWatchingIs%s', (watching) => {
    const value = snapshot()
    value.runtime.devWorkspace = devWorkspace
    value.runtime.agent = 'Local harness'
    value.runtime.sourceWatching = watching

    const footer = metadataPlacements(value, 220)
      .map(({ text }) => text)
      .join(' ')

    expect(footer).toContain('dev · Local harness')
    expect(footer).toContain(watching ? 'watching files' : 'watch off')
  })

  it('shouldClearWatchStatusWhenTheWatcherFails', async () => {
    let fail: (error: Error) => void = () => undefined
    vi.spyOn(projectWatch, 'watchAgentProject').mockImplementation((_project, _changed, failed) => {
      fail = failed
      return () => undefined
    })
    const controller = new ChatController(idleBackend(), { runtime: { devWorkspace } })
    const manager = new ConversationManager(controller, {
      fork: async () => controller,
      project: { root: '/workspace', entrypoint: '/workspace/agent.ts', language: 'typescript' },
      projectPrivatePaths: [],
      reloadProject: () => undefined,
    })
    try {
      expect(manager.getSnapshot().runtime.sourceWatching).toBe(true)

      fail(new Error('watch failed'))

      expect(manager.getSnapshot().runtime.sourceWatching).toBe(false)
    } finally {
      await manager.dispose()
    }
  })

  it('shouldKeepOrdinarySessionsUnchangedWhenNoWorkspaceIsSelected', async () => {
    const controller = new ChatController(idleBackend())
    try {
      expect(controller.getSnapshot().runtime.devWorkspace).toBeUndefined()
      expect(controller.getSnapshot().notices).toEqual([])
    } finally {
      await controller.dispose()
    }
  })
})
