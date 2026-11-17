import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { isRecord } from './values.js'

const LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 25
const OWNER = /^(\d+)-[0-9a-f-]{36}$/u
const BUSY_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM'])

export type LockBusyMessage = (holders: readonly number[]) => string

export class ProcessLockBusy extends Error {}

const agentBusy: LockBusyMessage = (holders) =>
  `Another strands dev process (${holders.join(', ')}) is still changing this agent. Try again when it finishes.`

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

export const withProcessLock = async <T>(
  lock: string,
  task: () => Promise<T>,
  busy: LockBusyMessage = agentBusy
): Promise<T> => {
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
      if (holders.length && Date.now() >= deadline) throw new ProcessLockBusy(busy(holders), { cause: error })
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
