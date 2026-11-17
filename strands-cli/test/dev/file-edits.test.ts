import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { editFile } from '../../src/dev/file-edits.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const module = new URL('../../src/dev/file-edits.ts', import.meta.url).href

const project = async (content = 'start\n') => {
  const root = await temporaryDirectory()
  const file = join(root, 'agent.ts')
  await writeFile(file, content)
  return { root, file }
}

const append =
  (line: string) =>
  (content: string): string =>
    `${content}${line}\n`

const deadProcessId = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

describe('editFile', () => {
  it('shouldKeepEveryEditWhenEditsOfOneAgentRunAtTheSameTime', async () => {
    const { root, file } = await project()

    await Promise.all(['one', 'two', 'three', 'four'].map((line) => editFile(root, file, append(line))))

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines[0]).toBe('start')
    expect(lines.slice(1).sort()).toEqual(['four', 'one', 'three', 'two'])
  })

  it('shouldWaitForAnotherProcessThatIsEditingTheSameAgent', async () => {
    const { root, file } = await project()
    const script = `const { editFile } = await import(${JSON.stringify(module)})
await editFile(${JSON.stringify(root)}, ${JSON.stringify(file)}, async (content) => {
  process.stdout.write('locked\\n')
  await new Promise((resolve) => setTimeout(resolve, 400))
  return content + 'child\\n'
})`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))

    await editFile(root, file, append('parent'))
    expect(await exited).toBe(0)

    expect(await readFile(file, 'utf8')).toBe('start\nchild\nparent\n')
  })

  it('shouldTakeOverALockThatAStoppedProcessLeftBehind', async () => {
    const { root, file } = await project()
    const lock = join(root, '.strands/state/edit.lock')
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, `${await deadProcessId()}-00000000-0000-4000-8000-000000000000`), '')

    await editFile(root, file, append('saved'))

    expect(await readFile(file, 'utf8')).toBe('start\nsaved\n')
    expect(await readdir(join(root, '.strands/state'))).toEqual([])
  })

  it('shouldApplyTheEditToTheNewContentWhenTheFileChangesDuringTheEdit', async () => {
    const { root, file } = await project()
    let calls = 0

    await editFile(root, file, async (content) => {
      calls += 1
      if (calls === 1) await writeFile(file, `${content}editor\n`)
      return `${content}saved\n`
    })

    expect(calls).toBe(2)
    expect(await readFile(file, 'utf8')).toBe('start\neditor\nsaved\n')
  })

  it.skipIf(process.platform === 'win32')('shouldKeepTheFileModeWhenTheEditReplacesTheFile', async () => {
    const { root, file } = await project()
    await chmod(file, 0o640)

    await editFile(root, file, append('saved'))

    expect((await stat(file)).mode & 0o777).toBe(0o640)
  })

  it('shouldNotWriteWhenTheEditChangesNothing', async () => {
    const { root, file } = await project()
    const before = await stat(file)

    expect(await editFile(root, file, (content) => content)).toBe(false)

    expect((await stat(file)).ino).toBe(before.ino)
  })

  it('shouldRefuseToReplaceALinkedFile', async () => {
    const { root, file } = await project()
    const link = join(root, 'linked.ts')
    await symlink(file, link)

    await expect(editFile(root, link, append('saved'))).rejects.toThrow('regular files')

    expect(await readFile(file, 'utf8')).toBe('start\n')
  })

  it('shouldReportTheFailureWhenTheEditThrows', async () => {
    const { root, file } = await project()

    await expect(
      editFile(root, file, () => {
        throw new Error('cannot change this file')
      })
    ).rejects.toThrow('cannot change this file')

    expect(await readFile(file, 'utf8')).toBe('start\n')
    await editFile(root, file, append('saved'))
    expect(await readFile(file, 'utf8')).toBe('start\nsaved\n')
  })
})
