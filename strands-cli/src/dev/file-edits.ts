import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { isRecord } from '../values.js'

const LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 25
const EDIT_ATTEMPTS = 3
const OWNER = /^(\d+)-[0-9a-f-]{36}$/u
const BUSY_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM'])

export type FileEdit = (content: string) => string | Promise<string>

interface FileState {
  content: string
  details: Stats
}

const queues = new Map<string, Promise<unknown>>()

const stateFolder = (owner: string): string => join(resolve(owner), '.strands', 'state')

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined

const processRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

const releaseFolder = async (lock: string): Promise<void> => {
  try {
    await rmdir(lock)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(errorCode(error) ?? '')) throw error
  }
}

const runningHolders = async (lock: string): Promise<number[]> => {
  let owners: string[]
  try {
    owners = await readdir(lock)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const running: number[] = []
  for (const owner of owners) {
    const pid = Number(OWNER.exec(owner)?.[1])
    if (Number.isSafeInteger(pid) && pid > 0 && processRunning(pid)) running.push(pid)
    else await unlink(join(lock, owner)).catch(() => undefined)
  }
  if (!running.length) await releaseFolder(lock)
  return running
}

const withProcessLock = async <T>(lock: string, task: () => Promise<T>): Promise<T> => {
  const owner = `${process.pid}-${randomUUID()}`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const staged = await mkdtemp(`${lock}-`)
    try {
      await writeFile(join(staged, owner), '', { mode: 0o600 })
      await rename(staged, lock)
      break
    } catch (error) {
      if (!BUSY_CODES.has(errorCode(error) ?? '')) throw error
      const holders = await runningHolders(lock)
      if (holders.length && Date.now() >= deadline)
        throw new Error(
          `Another strands dev process (${holders.join(', ')}) is still changing this agent. Try again when it finishes.`,
          { cause: error }
        )
      if (holders.length) await delay(LOCK_RETRY_MS)
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  }
  try {
    return await task()
  } finally {
    await unlink(join(lock, owner)).catch(() => undefined)
    await releaseFolder(lock)
  }
}

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

export const editFile = async (owner: string, file: string, edit: FileEdit): Promise<boolean> =>
  withFolderLock(owner, async () => {
    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
      const before = await readRegularFile(file)
      const after = await edit(before.content)
      if (after === before.content) return false
      if (await replaceUnchanged(owner, file, before, after)) return true
    }
    throw new Error(`${file} kept changing while strands dev saved it. Try again.`)
  })
