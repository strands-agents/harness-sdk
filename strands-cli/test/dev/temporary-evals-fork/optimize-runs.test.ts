import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  dropTemporaryOptimizeRecord,
  isTemporaryOptimizeAlive,
  readTemporaryOptimizeRecords,
  saveTemporaryOptimizeRecord,
  waitForTemporaryOptimize,
  type TemporaryOptimizeRecord,
} from '../../../src/dev/temporary-evals-fork/optimize-runs.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const recordIn = (folder: string, name: string, startedAt: number, pid?: number): TemporaryOptimizeRecord => ({
  version: 1,
  experiment: join(folder, '..', 'experiments', 'refunds.json'),
  record: join(folder, name),
  space: join(folder, `${name}.space.json`),
  iterations: 4,
  startedAt,
  ...(pid === undefined ? {} : { pid }),
})

describe('TEMPORARY optimize run records', () => {
  it('shouldListSavedRecordsOldestFirstAndForgetADroppedOne', async () => {
    const folder = await temporaryDirectory()
    const older = recordIn(folder, '20261111-150405-refunds', 1)
    const newer = recordIn(folder, '20261111-160405-refunds', 2, 99)
    await saveTemporaryOptimizeRecord(newer)
    await saveTemporaryOptimizeRecord(older)

    expect(await readTemporaryOptimizeRecords(folder)).toEqual([older, newer])

    await dropTemporaryOptimizeRecord(older)
    expect(await readTemporaryOptimizeRecords(folder)).toEqual([newer])
  })

  it.skipIf(process.platform === 'win32')(
    'shouldSeeTheRunAliveOnlyWhileItsProcessStillNamesTheRecord',
    async () => {
      const folder = await temporaryDirectory()
      const record = recordIn(folder, '20261111-150405-refunds', 1)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)', record.record], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('spawn', resolve))
      const running = { ...record, pid: child.pid! }

      expect(await isTemporaryOptimizeAlive(running)).toBe(true)
      expect(await isTemporaryOptimizeAlive({ ...running, record: join(folder, 'another-run') })).toBe(false)
      await waitForTemporaryOptimize(running)
      expect(await isTemporaryOptimizeAlive(running)).toBe(false)
    },
    10_000
  )
})
