import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { devFailedTurnRecord } from '../../src/dev/failed-turns.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const turn = (index: number) => ({
  prompt: `question ${index}`,
  error: 'The security token included in the request is expired',
})

describe('devFailedTurnRecord', () => {
  it('shouldGiveTheSavedTurnsBackWhenTheSameSessionOpensAgain', async () => {
    const directory = await temporaryDirectory()

    await (await devFailedTurnRecord(directory, 'session-1')).save([turn(1), turn(2)])

    expect((await devFailedTurnRecord(directory, 'session-1')).saved).toEqual([turn(1), turn(2)])
    expect((await devFailedTurnRecord(directory, 'session-2')).saved).toEqual([])
  })

  it('shouldKeepOnlyTheLastTenTurns', async () => {
    const directory = await temporaryDirectory()

    await (
      await devFailedTurnRecord(directory, 'session-1')
    ).save(Array.from({ length: 12 }, (_, index) => turn(index)))

    expect((await devFailedTurnRecord(directory, 'session-1')).saved.map(({ prompt }) => prompt)).toEqual(
      Array.from({ length: 10 }, (_, index) => `question ${index + 2}`)
    )
  })

  it('shouldSaveInTheStateFolderOfTheWorkspaceWithASafeFileName', async () => {
    const directory = await temporaryDirectory()

    await (await devFailedTurnRecord(directory, '../session 1')).save([turn(1)])

    const saved = JSON.parse(
      await readFile(join(directory, '.strands', 'state', 'failed-turns', '.._session_1.json'), 'utf8')
    )
    expect(saved).toEqual([turn(1)])
  })

  it.each([
    ['NotJson', 'not json'],
    ['NoList', '{"prompt":"a","error":"b"}'],
  ])('shouldGiveNoTurnsWhenTheFileHas%s', async (_name, contents) => {
    const directory = await temporaryDirectory()
    const folder = join(directory, '.strands', 'state', 'failed-turns')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'session-1.json'), contents)

    expect((await devFailedTurnRecord(directory, 'session-1')).saved).toEqual([])
  })

  it('shouldDropEntriesThatAreNotTurnsAndRemoveTerminalControls', async () => {
    const directory = await temporaryDirectory()
    const folder = join(directory, '.strands', 'state', 'failed-turns')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'session-1.json'),
      JSON.stringify([{ prompt: 'ok\u001b[31m', error: 'boom' }, { prompt: 1 }, 'text'])
    )

    expect((await devFailedTurnRecord(directory, 'session-1')).saved).toEqual([{ prompt: 'ok', error: 'boom' }])
  })
})
