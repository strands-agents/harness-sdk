import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { savedSessionCount } from '../../src/session/sessions.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const saveSession = async (folder: string, id: string, messages: number): Promise<void> => {
  const snapshots = join(folder, id, 'scopes', 'agent', 'agent', 'snapshots')
  await mkdir(snapshots, { recursive: true })
  const turns = Array.from({ length: messages }, () => ({ role: 'user', content: [{ text: 'hello' }] }))
  await writeFile(join(snapshots, 'snapshot_latest.json'), JSON.stringify({ data: { messages: turns } }))
}

describe('savedSessionCount', () => {
  it('shouldCountOnlyTheSessionsWithMessagesWhenOneIsExcluded', async () => {
    const folder = await temporaryDirectory()
    await saveSession(folder, 'first', 2)
    await saveSession(folder, 'second', 1)
    await saveSession(folder, 'current', 4)
    await saveSession(folder, 'empty', 0)
    await mkdir(join(folder, 'no-snapshot'))
    await writeFile(join(folder, 'notes.txt'), 'not a session')

    await expect(savedSessionCount(folder, 'current')).resolves.toBe(2)
  })

  it('shouldCountNothingWhenTheFolderDoesNotExist', async () => {
    const folder = join(await temporaryDirectory(), 'missing')

    await expect(savedSessionCount(folder, 'current')).resolves.toBe(0)
  })
})
