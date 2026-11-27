import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ignoreStateFolder } from '../../src/project/state-folder.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

describe('ignoreStateFolder', () => {
  it('shouldWriteAnIgnoreFileForTheWholeFolderWhenTheFolderHasNone', async () => {
    const state = await temporaryDirectory()

    expect(ignoreStateFolder(state)).toBe(true)

    expect(await readFile(join(state, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('shouldKeepTheIgnoreFileWhenTheFolderAlreadyHasOne', async () => {
    const state = await temporaryDirectory()
    await writeFile(join(state, '.gitignore'), 'custom\n')

    expect(ignoreStateFolder(state)).toBe(false)

    expect(await readFile(join(state, '.gitignore'), 'utf8')).toBe('custom\n')
  })
})
