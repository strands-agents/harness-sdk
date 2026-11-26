import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { evalsDevSessions } from '../../../../src/dev/evals/sessions/sessions.js'
import { chat, sessionsFor } from '../../../fixtures/evals-sessions.js'

describe('dev sessions', () => {
  it('shouldShareTheSessionsWhenTheSameWorkspaceOpensAgain', async () => {
    const { workspace, sessions } = await sessionsFor()

    const again = evalsDevSessions({ workspace, agent: () => ({}) })

    expect(again).toBe(sessions)
  })

  it('shouldOpenAFileThroughTheLatestChatScreenAndSaySoWhenItHasNoEditor', async () => {
    const { workspace, sessions } = await sessionsFor()
    const openFile = vi.fn(async (_path: string): Promise<void> => {})

    await expect(sessions.openFile('/w/a.json')).rejects.toThrow('This terminal cannot open an editor.')
    evalsDevSessions({ workspace, agent: () => ({}), context: { ...chat().context, openFile } })
    await sessions.openFile('/w/a.json')

    expect(openFile).toHaveBeenCalledWith(resolve(workspace.root, '/w/a.json'))
  })
})
