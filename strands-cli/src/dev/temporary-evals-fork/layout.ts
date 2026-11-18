import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { isRecord } from '../../values.js'

const TEMPORARY_FOLDER = 'tmp'
const EXPERIMENTS_FOLDER = 'experiments'
const STATE_FOLDER = '.state'
const OUTSIDE_FOLDER = 'outside-experiments'
const RUNS_FOLDER = 'runs'
const OPTIMIZATIONS_FOLDER = 'optimizations'
const OPTIMIZER_FOLDER = 'optimizer'
const DRAFTS_FOLDER = 'drafts'
const SKILLS_FOLDER = 'skills'
const EVALS_ENVIRONMENT_FOLDER = 'evals-env'
const EXPERIMENT_SUFFIX = '.json'
const LATEST_REPORT_SUFFIX = '.report.json'
const REPORT_FILE = 'report.json'
const LOG_FILE = 'run.log'
const RECORD_FILE = 'record.json'
const CASE_STORE_FOLDER = 'cases'
const CASES_COPY_FILE = 'experiment.json'
const SPACE_FILE = 'space.json'
const TASK_FILE = 'task.py'
const LATEST_FILE = 'latest.json'
const EXPERIMENTS_IGNORE_FILE = '.gitignore'
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/u

export const TEMPORARY_KEPT_TEST_RUNS = 20

export interface TemporaryTestRunFiles {
  readonly folder: string
  readonly report: string
  readonly log: string
  readonly store: string
  readonly copy: string
  readonly record: string
}

export interface TemporaryOptimizationFiles {
  readonly folder: string
  readonly record: string
  readonly log: string
  readonly space: string
  readonly copy: string
  readonly resume: string
  readonly task: string
}

export interface TemporaryRunFolder {
  readonly home: string
  readonly name: string
  readonly folder: string
  readonly stamp: string
  readonly startedAt: number
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

export const temporaryExperimentsFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, EXPERIMENTS_FOLDER)

const EXPERIMENTS_IGNORED = [
  `*/${RUNS_FOLDER}/`,
  `*/${OPTIMIZATIONS_FOLDER}/`,
  `*/${STATE_FOLDER}/`,
  `*/*${LATEST_REPORT_SUFFIX}`,
]

export const ensureTemporaryExperimentsFolder = async (workspaceDirectory: string): Promise<string> => {
  const folder = temporaryExperimentsFolder(workspaceDirectory)
  await mkdir(folder, { recursive: true })
  try {
    await writeFile(join(folder, EXPERIMENTS_IGNORE_FILE), `${EXPERIMENTS_IGNORED.join('\n')}\n`, { flag: 'wx' })
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error
  }
  return folder
}

export const temporaryStateFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, TEMPORARY_FOLDER, STATE_FOLDER)

export const temporaryDraftsFolder = (workspaceDirectory: string): string =>
  join(temporaryStateFolder(workspaceDirectory), DRAFTS_FOLDER)

export const temporarySkillsFolder = (workspaceDirectory: string): string =>
  join(temporaryStateFolder(workspaceDirectory), SKILLS_FOLDER)

export const temporaryEvalsEnvironmentFolder = (workspaceDirectory: string): string =>
  join(temporaryStateFolder(workspaceDirectory), EVALS_ENVIRONMENT_FOLDER)

export const temporaryExperimentFile = (workspaceDirectory: string, name: string): string =>
  join(temporaryExperimentsFolder(workspaceDirectory), name, `${name}${EXPERIMENT_SUFFIX}`)

export const temporaryExperimentName = (experimentFile: string): string => basename(experimentFile, EXPERIMENT_SUFFIX)

const outsideHomes = (workspaceDirectory: string): string =>
  join(temporaryStateFolder(workspaceDirectory), OUTSIDE_FOLDER)

export const temporaryOutsideExperimentHome = (workspaceDirectory: string, name: string): string =>
  join(outsideHomes(workspaceDirectory), name)

export const temporaryExperimentHome = (workspaceDirectory: string, experimentFile: string): string => {
  const file = resolve(experimentFile)
  const name = temporaryExperimentName(file)
  const inside = file === resolve(temporaryExperimentFile(workspaceDirectory, name))
  return inside ? dirname(file) : temporaryOutsideExperimentHome(workspaceDirectory, name)
}

export const temporaryLatestReport = (home: string): string => join(home, `${basename(home)}${LATEST_REPORT_SUFFIX}`)

export const temporaryLatestRecord = (home: string): string => join(home, STATE_FOLDER, LATEST_FILE)

export const temporaryRunStamp = (now: Date): string =>
  now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)

export const temporaryStampTime = (stamp: string): number | undefined => {
  const match = STAMP.exec(stamp)
  if (!match) return undefined
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(Number)
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

export const temporaryTestRunFiles = (home: string, stamp: string): TemporaryTestRunFiles => {
  const folder = join(home, RUNS_FOLDER, stamp)
  const state = join(folder, STATE_FOLDER)
  return {
    folder,
    report: join(folder, REPORT_FILE),
    log: join(folder, LOG_FILE),
    store: join(state, CASE_STORE_FOLDER),
    copy: join(state, CASES_COPY_FILE),
    record: join(state, RECORD_FILE),
  }
}

export const temporaryOptimizationFiles = (home: string, stamp: string): TemporaryOptimizationFiles => {
  const folder = join(home, OPTIMIZATIONS_FOLDER, stamp)
  const state = join(folder, STATE_FOLDER)
  return {
    folder,
    record: join(folder, OPTIMIZER_FOLDER),
    log: join(folder, LOG_FILE),
    space: join(state, SPACE_FILE),
    copy: join(state, CASES_COPY_FILE),
    resume: join(state, RECORD_FILE),
    task: join(state, TASK_FILE),
  }
}

const runOf = (file: string): { home: string; stamp: string } => {
  const folder = dirname(file)
  return { home: dirname(dirname(folder)), stamp: basename(folder) }
}

export const temporaryTestRunOf = (report: string): TemporaryTestRunFiles => {
  const { home, stamp } = runOf(report)
  return temporaryTestRunFiles(home, stamp)
}

export const temporaryOptimizationOf = (record: string): TemporaryOptimizationFiles => {
  const { home, stamp } = runOf(record)
  return temporaryOptimizationFiles(home, stamp)
}

export const temporaryOptimizationLabel = (record: string): { experiment: string; startedAt?: number } => {
  const { home, stamp } = runOf(record)
  const startedAt = temporaryStampTime(stamp)
  return { experiment: basename(home), ...(startedAt === undefined ? {} : { startedAt }) }
}

export const temporaryOptimizationRunName = (record: string): string => {
  const { home, stamp } = runOf(record)
  return `${stamp}-${basename(home)}`
}

export const temporaryFreeStamp = (taken: (stamp: string) => boolean, now: Date): string => {
  const base = temporaryRunStamp(now)
  if (!taken(base)) return base
  for (let suffix = 2; ; suffix += 1) if (!taken(`${base}-${suffix}`)) return `${base}-${suffix}`
}

const folderNames = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

export const listTemporaryExperimentFiles = async (experimentsFolder: string): Promise<string[]> =>
  (await folderNames(experimentsFolder))
    .map((name) => join(experimentsFolder, name, `${name}${EXPERIMENT_SUFFIX}`))
    .filter((file) => existsSync(file))

const homes = async (workspaceDirectory: string): Promise<string[]> => {
  const inside = temporaryExperimentsFolder(workspaceDirectory)
  const outside = outsideHomes(workspaceDirectory)
  return [
    ...(await folderNames(inside)).map((name) => join(inside, name)),
    ...(await folderNames(outside)).map((name) => join(outside, name)),
  ]
}

const stampOrder = (stamp: string): number => {
  const suffix = Number(STAMP.exec(stamp)?.[7] ?? 1)
  return (temporaryStampTime(stamp) ?? 0) + suffix / 1000
}

const homeRuns = async (home: string, kind: string): Promise<TemporaryRunFolder[]> => {
  const parent = join(home, kind)
  return (await folderNames(parent))
    .flatMap((stamp) => {
      const startedAt = temporaryStampTime(stamp)
      return startedAt === undefined
        ? []
        : [{ home, name: basename(home), folder: join(parent, stamp), stamp, startedAt }]
    })
    .sort((left, right) => stampOrder(left.stamp) - stampOrder(right.stamp))
}

const runFolders = async (workspaceDirectory: string, kind: string): Promise<TemporaryRunFolder[]> =>
  (await Promise.all((await homes(workspaceDirectory)).map((home) => homeRuns(home, kind))))
    .flat()
    .sort((left, right) => stampOrder(left.stamp) - stampOrder(right.stamp))

export const listTemporaryTestRuns = (workspaceDirectory: string): Promise<TemporaryRunFolder[]> =>
  runFolders(workspaceDirectory, RUNS_FOLDER)

export const listTemporaryOptimizations = (workspaceDirectory: string): Promise<TemporaryRunFolder[]> =>
  runFolders(workspaceDirectory, OPTIMIZATIONS_FOLDER)

export const pruneTemporaryTestRuns = async (
  home: string,
  kept: readonly string[],
  keep = TEMPORARY_KEPT_TEST_RUNS
): Promise<number> => {
  const runs = await homeRuns(home, RUNS_FOLDER)
  const protectedFolders = new Set(kept.map((path) => resolve(path)))
  const old = runs
    .slice(0, Math.max(0, runs.length - keep))
    .filter(
      ({ folder, stamp }) =>
        !protectedFolders.has(resolve(folder)) && !existsSync(temporaryTestRunFiles(home, stamp).record)
    )
  await Promise.all(old.map(({ folder }) => rm(folder, { recursive: true, force: true })))
  return old.length
}
