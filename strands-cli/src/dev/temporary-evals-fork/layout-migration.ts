import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import { isRecord } from '../../values.js'
import { isTemporaryProcessAlive } from './background-runs.js'
import {
  temporaryDraftsFolder,
  temporaryExperimentFile,
  temporaryExperimentHome,
  temporaryExperimentsFolder,
  temporaryLatestRecord,
  temporaryLatestReport,
  temporaryOptimizationFiles,
  temporaryOutsideExperimentHome,
  temporarySkillsFolder,
  temporaryTestRunFiles,
} from './layout.js'

export interface TemporaryMigration {
  readonly moved: number
  readonly problems: readonly string[]
}

const OLD_RUN = /^(\d{8}-\d{6})-(.+)$/u
const TEST_SUFFIXES = ['.experiment.json', '.json', '.log', '.cases'] as const
const OPTIMIZATION_FILE_SUFFIXES = ['.experiment.json', '.space.json', '.log'] as const
const RUNNING_FOLDER = 'running'
const LATEST_FOLDER = 'latest'
const ready = new Map<string, Promise<TemporaryMigration>>()

type Json = Record<string, unknown>

interface Migration {
  readonly directory: string
  move(from: string, to: string): Promise<void>
  attempt(what: string, work: () => Promise<void>): Promise<void>
  result(): TemporaryMigration
}

const migration = (directory: string): Migration => {
  let moved = 0
  const problems: string[] = []
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work()
    } catch (error) {
      problems.push(`${what}: ${errorMessage(error)}`)
    }
  }
  return {
    directory,
    attempt,
    move: (from, to) =>
      attempt(from, async () => {
        if (!existsSync(from) || existsSync(to)) return
        await mkdir(dirname(to), { recursive: true })
        await rename(from, to)
        moved += 1
      }),
    result: () => ({ moved, problems }),
  }
}

const oldFolder = (directory: string, name: string): string => join(directory, 'tmp', name)

const entries = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder)).sort()
  } catch (error) {
    if (isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
    throw error
  }
}

const isFolder = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => undefined))?.isDirectory() ?? false

const readJson = async (path: string): Promise<Json | undefined> => {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const writeJson = async (path: string, value: Json): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

const stemOf = (name: string, suffixes: readonly string[]): string | undefined => {
  const suffix = suffixes.find((ending) => name.endsWith(ending))
  return suffix === undefined ? undefined : name.slice(0, name.length - suffix.length)
}

const oldExperiment = (directory: string, name: string): string =>
  join(temporaryExperimentsFolder(directory), `${name}.json`)

const newExperiment = (directory: string, name: string, recorded?: unknown): string => {
  const moved = temporaryExperimentFile(directory, name)
  if (typeof recorded !== 'string' || recorded === oldExperiment(directory, name)) return moved
  return recorded
}

const homeOf = (directory: string, name: string, recorded?: unknown): string => {
  const experiment = newExperiment(directory, name, recorded)
  const orphan = experiment === temporaryExperimentFile(directory, name) && !existsSync(experiment)
  return orphan ? temporaryOutsideExperimentHome(directory, name) : temporaryExperimentHome(directory, experiment)
}

interface Running {
  readonly path: string
  readonly record: Json
  readonly stem: string
}

const runningRecords = async (folder: string, target: 'report' | 'record'): Promise<Running[]> => {
  const records = await Promise.all(
    (await entries(join(folder, RUNNING_FOLDER)))
      .filter((name) => name.endsWith('.json'))
      .map(async (name): Promise<Running | undefined> => {
        const path = join(folder, RUNNING_FOLDER, name)
        const record = await readJson(path)
        const tracked = record?.[target]
        if (!record || typeof tracked !== 'string') return undefined
        return { path, record, stem: basename(tracked, '.json') }
      })
  )
  return records.filter((record): record is Running => record !== undefined)
}

const isAlive = ({ record }: Running, target: 'report' | 'record'): Promise<boolean> =>
  isTemporaryProcessAlive(typeof record.pid === 'number' ? record.pid : undefined, String(record[target]))

const moveExperiments = async (work: Migration): Promise<void> => {
  const folder = temporaryExperimentsFolder(work.directory)
  for (const name of await entries(folder)) {
    if (name.endsWith('.json'))
      await work.move(join(folder, name), temporaryExperimentFile(work.directory, name.slice(0, -5)))
  }
  await work.move(join(folder, 'drafts'), temporaryDraftsFolder(work.directory))
}

const moveTestRecord = async (work: Migration, reports: string, { path, record, stem }: Running): Promise<void> => {
  const [, stamp = '', name = ''] = OLD_RUN.exec(stem) ?? []
  const files = temporaryTestRunFiles(homeOf(work.directory, name, record.experiment), stamp)
  const experiment = newExperiment(work.directory, name, record.experiment)
  const cases =
    record.cases === join(reports, `${stem}.experiment.json`)
      ? files.copy
      : record.cases === oldExperiment(work.directory, name)
        ? experiment
        : record.cases
  await work.attempt(path, async () => {
    await writeJson(files.record, {
      ...record,
      experiment,
      cases,
      report: files.report,
      log: files.log,
      store: files.store,
    })
    await rm(path, { force: true })
  })
}

const moveLatest = async (work: Migration, reports: string): Promise<void> => {
  for (const file of await entries(join(reports, LATEST_FOLDER))) {
    const name = stemOf(file, ['.json'])
    const saved = await readJson(join(reports, LATEST_FOLDER, file))
    const stamp = typeof saved?.report === 'string' ? OLD_RUN.exec(basename(saved.report, '.json'))?.[1] : undefined
    if (!name || !stamp) continue
    const home = homeOf(work.directory, name)
    const { folder, report } = temporaryTestRunFiles(home, stamp)
    if (!existsSync(report) || existsSync(temporaryLatestRecord(home))) continue
    await work.attempt(join(reports, LATEST_FOLDER, file), async () => {
      await copyFile(report, temporaryLatestReport(home))
      await writeJson(temporaryLatestRecord(home), { run: relative(home, folder), seconds: saved?.seconds ?? 0 })
      await rm(join(reports, LATEST_FOLDER, file), { force: true })
    })
  }
}

const moveTests = async (work: Migration): Promise<number> => {
  const reports = oldFolder(work.directory, 'reports')
  const records = await runningRecords(reports, 'report')
  const live = new Set<string>()
  for (const running of records) {
    if (await isAlive(running, 'report')) live.add(running.stem)
    else await moveTestRecord(work, reports, running)
  }
  const recorded = new Map(records.map(({ stem, record }) => [stem, record.experiment]))
  const stems = new Set((await entries(reports)).flatMap((name) => stemOf(name, TEST_SUFFIXES) ?? []))
  for (const stem of stems) {
    const [, stamp, name] = OLD_RUN.exec(stem) ?? []
    if (!stamp || !name || live.has(stem)) continue
    const files = temporaryTestRunFiles(homeOf(work.directory, name, recorded.get(stem)), stamp)
    await work.move(join(reports, `${stem}.json`), files.report)
    await work.move(join(reports, `${stem}.log`), files.log)
    await work.move(join(reports, `${stem}.cases`), files.store)
    await work.move(join(reports, `${stem}.experiment.json`), files.copy)
  }
  await moveLatest(work, reports)
  return live.size
}

const moveOptimizationRecord = async (
  work: Migration,
  folder: string,
  { path, record, stem }: Running
): Promise<void> => {
  const [, stamp = '', name = ''] = OLD_RUN.exec(stem) ?? []
  const files = temporaryOptimizationFiles(homeOf(work.directory, name, record.experiment), stamp)
  const space = record.space === join(folder, `${stem}.space.json`) ? files.space : record.space
  await work.attempt(path, async () => {
    await writeJson(files.resume, {
      ...record,
      experiment: newExperiment(work.directory, name, record.experiment),
      record: files.record,
      space,
    })
    await rm(path, { force: true })
  })
}

const optimizationStems = async (folder: string): Promise<Set<string>> => {
  const stems = new Set<string>()
  for (const name of await entries(folder)) {
    const stem = (await isFolder(join(folder, name))) ? name : stemOf(name, OPTIMIZATION_FILE_SUFFIXES)
    if (stem && OLD_RUN.test(stem)) stems.add(stem)
  }
  return stems
}

const moveOptimizations = async (work: Migration): Promise<number> => {
  const folder = oldFolder(work.directory, 'optimization')
  const records = await runningRecords(folder, 'record')
  const live = new Set<string>()
  for (const running of records) {
    if (await isAlive(running, 'record')) live.add(running.stem)
    else await moveOptimizationRecord(work, folder, running)
  }
  const recorded = new Map(records.map(({ stem, record }) => [stem, record.experiment]))
  for (const stem of await optimizationStems(folder)) {
    const [, stamp = '', experiment = ''] = OLD_RUN.exec(stem) ?? []
    if (live.has(stem)) continue
    const files = temporaryOptimizationFiles(homeOf(work.directory, experiment, recorded.get(stem)), stamp)
    await work.move(join(folder, stem), files.record)
    await work.move(join(folder, `${stem}.log`), files.log)
    await work.move(join(folder, `${stem}.space.json`), files.space)
    await work.move(join(folder, `${stem}.experiment.json`), files.copy)
  }
  return live.size
}

const removeOldEnvironment = async (work: Migration): Promise<void> => {
  const venv = join(oldFolder(work.directory, 'optimization'), '.venv')
  await work.attempt(venv, () => rm(venv, { recursive: true, force: true }))
}

const removeEmpty = async (folders: readonly string[]): Promise<void> => {
  for (const folder of folders) await rmdir(folder).catch(() => undefined)
}

const migrate = async (directory: string): Promise<TemporaryMigration> => {
  const work = migration(directory)
  let liveRuns = 0
  await work.attempt('experiments', () => moveExperiments(work))
  await work.attempt('test reports', async () => {
    liveRuns += await moveTests(work)
  })
  await work.attempt('optimization runs', async () => {
    liveRuns += await moveOptimizations(work)
  })
  if (liveRuns === 0) await removeOldEnvironment(work)
  await work.move(oldFolder(directory, 'skills'), temporarySkillsFolder(directory))
  const reports = oldFolder(directory, 'reports')
  const optimization = oldFolder(directory, 'optimization')
  await removeEmpty([
    join(reports, LATEST_FOLDER),
    join(reports, RUNNING_FOLDER),
    reports,
    join(optimization, RUNNING_FOLDER),
    optimization,
  ])
  return work.result()
}

export const temporaryWorkspaceReady = (workspaceDirectory: string): Promise<TemporaryMigration> => {
  let work = ready.get(workspaceDirectory)
  if (!work) {
    work = migrate(workspaceDirectory)
    ready.set(workspaceDirectory, work)
  }
  return work
}
