import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { withProcessLock } from '../process-lock.js'
import { isRecord } from '../values.js'

const EDIT_ATTEMPTS = 3

interface FileState {
  content: string
  details: Stats
}

const queues = new Map<string, Promise<unknown>>()

const stateFolder = (owner: string): string => join(resolve(owner), '.strands', 'state')

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined

const withFolderLock = async <T>(owner: string, task: () => Promise<T>): Promise<T> => {
  const folder = stateFolder(owner)
  const previous = queues.get(folder) ?? Promise.resolve()
  const run = previous.then(async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 })
    return withProcessLock(join(folder, 'edit.lock'), task)
  })
  const settled = run.catch(() => undefined)
  queues.set(folder, settled)
  void settled.then(() => {
    if (queues.get(folder) === settled) queues.delete(folder)
  })
  return run
}

const readRegularFile = async (file: string): Promise<FileState> => {
  const details = await lstat(file)
  if (details.isSymbolicLink() || !details.isFile())
    throw new Error(`strands dev changes only regular files, not links: ${file}`)
  if (details.nlink !== 1) throw new Error(`strands dev does not replace a hard-linked file: ${file}`)
  return { content: await readFile(file, 'utf8'), details }
}

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino

const replaceUnchanged = async (owner: string, file: string, before: FileState, after: string): Promise<boolean> => {
  const staging = await mkdtemp(join(stateFolder(owner), 'edit-'))
  try {
    const staged = join(staging, basename(file))
    await writeFile(staged, after, { mode: 0o600 })
    await chmod(staged, before.details.mode & 0o7777)
    const current = await readRegularFile(file)
    if (current.content !== before.content || !sameFile(current.details, before.details)) return false
    try {
      await rename(staged, file)
    } catch (error) {
      if (errorCode(error) !== 'EXDEV') throw error
      await writeFile(file, after)
    }
    return true
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export const editFile = async (
  owner: string,
  file: string,
  edit: (content: string) => string | Promise<string>
): Promise<boolean> =>
  withFolderLock(owner, async () => {
    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
      const before = await readRegularFile(file)
      const after = await edit(before.content)
      if (after === before.content) return false
      if (await replaceUnchanged(owner, file, before, after)) return true
    }
    throw new Error(`${file} kept changing while strands dev saved it. Try again.`)
  })
