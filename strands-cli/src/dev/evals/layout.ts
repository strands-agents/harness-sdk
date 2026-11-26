import { existsSync, watch, type FSWatcher } from 'node:fs'
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
const EXPERIMENT_CHANGE_DEBOUNCE_MS = 200

const KEPT_EVALUATION_RUNS = 20

export interface EvaluationRunFiles {
  readonly folder: string
  readonly report: string
  readonly log: string
  readonly store: string
  readonly copy: string
  readonly record: string
  readonly task: string
}

export interface EvalsOptimizationFiles {
  readonly folder: string
  readonly record: string
  readonly log: string
  readonly space: string
  readonly copy: string
  readonly resume: string
  readonly task: string
}

interface EvalsRunFolder {
  readonly home: string
  readonly name: string
  readonly folder: string
  readonly stamp: string
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

export const evalsExperimentsFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, EXPERIMENTS_FOLDER)

const EXPERIMENTS_IGNORED = [
  `*/${RUNS_FOLDER}/`,
  `*/${OPTIMIZATIONS_FOLDER}/`,
  `*/${STATE_FOLDER}/`,
  `*/*${LATEST_REPORT_SUFFIX}`,
]

export const ensureEvalsExperimentsFolder = async (workspaceDirectory: string): Promise<string> => {
  const folder = evalsExperimentsFolder(workspaceDirectory)
  await mkdir(folder, { recursive: true })
  try {
    await writeFile(join(folder, EXPERIMENTS_IGNORE_FILE), `${EXPERIMENTS_IGNORED.join('\n')}\n`, { flag: 'wx' })
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error
  }
  return folder
}

export const evalsStateFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, TEMPORARY_FOLDER, STATE_FOLDER)

export const evalsDraftsFolder = (workspaceDirectory: string): string =>
  join(evalsStateFolder(workspaceDirectory), DRAFTS_FOLDER)

export const evalsSkillsFolder = (workspaceDirectory: string): string =>
  join(evalsStateFolder(workspaceDirectory), SKILLS_FOLDER)

export const evalsEnvironmentFolder = (workspaceDirectory: string): string =>
  join(evalsStateFolder(workspaceDirectory), EVALS_ENVIRONMENT_FOLDER)

export const evalsExperimentFile = (workspaceDirectory: string, name: string): string =>
  join(evalsExperimentsFolder(workspaceDirectory), name, `${name}${EXPERIMENT_SUFFIX}`)

const outsideHomes = (workspaceDirectory: string): string => join(evalsStateFolder(workspaceDirectory), OUTSIDE_FOLDER)

export const evalsOutsideExperimentHome = (workspaceDirectory: string, name: string): string =>
  join(outsideHomes(workspaceDirectory), name)

export const evalsExperimentHome = (workspaceDirectory: string, experimentFile: string): string => {
  const file = resolve(experimentFile)
  const name = basename(file, EXPERIMENT_SUFFIX)
  const inside = file === resolve(evalsExperimentFile(workspaceDirectory, name))
  return inside ? dirname(file) : evalsOutsideExperimentHome(workspaceDirectory, name)
}

export const evalsLatestReport = (home: string): string => join(home, `${basename(home)}${LATEST_REPORT_SUFFIX}`)

export const evalsLatestRecord = (home: string): string => join(home, STATE_FOLDER, LATEST_FILE)

export const evalsRunStamp = (now: Date): string =>
  now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)

export const evalsStampTime = (stamp: string): number | undefined => {
  const match = STAMP.exec(stamp)
  if (!match) return undefined
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(Number)
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

export const evaluationRunFiles = (home: string, stamp: string): EvaluationRunFiles => {
  const folder = join(home, RUNS_FOLDER, stamp)
  const state = join(folder, STATE_FOLDER)
  return {
    folder,
    report: join(folder, REPORT_FILE),
    log: join(folder, LOG_FILE),
    store: join(state, CASE_STORE_FOLDER),
    copy: join(state, CASES_COPY_FILE),
    record: join(state, RECORD_FILE),
    task: join(state, TASK_FILE),
  }
}

export const evalsOptimizationFiles = (home: string, stamp: string): EvalsOptimizationFiles => {
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

export const evaluationRunOf = (report: string): EvaluationRunFiles => {
  const { home, stamp } = runOf(report)
  return evaluationRunFiles(home, stamp)
}

export const evalsOptimizationOf = (record: string): EvalsOptimizationFiles => {
  const { home, stamp } = runOf(record)
  return evalsOptimizationFiles(home, stamp)
}

export const evalsOptimizationRunName = (record: string): string => {
  const { home, stamp } = runOf(record)
  return `${stamp}-${basename(home)}`
}

export const evalsFreeStamp = (taken: (stamp: string) => boolean, now: Date): string => {
  const base = evalsRunStamp(now)
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

export const listEvalsExperimentFiles = async (experimentsFolder: string): Promise<string[]> =>
  (await folderNames(experimentsFolder))
    .map((name) => join(experimentsFolder, name, `${name}${EXPERIMENT_SUFFIX}`))
    .filter((file) => existsSync(file))

export const watchEvalsExperiments = (
  experimentsFolder: string,
  onChange: () => void,
  onStop: (error: Error) => void
): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const folders = new Map<string, FSWatcher>()
  const changed = (): void => {
    clearTimeout(timer)
    timer = setTimeout(onChange, EXPERIMENT_CHANGE_DEBOUNCE_MS)
    timer.unref()
  }
  const forget = (name: string): void => {
    folders.get(name)?.close()
    folders.delete(name)
  }
  const follow = (name: string): void => {
    if (folders.has(name)) return
    const file = `${name}${EXPERIMENT_SUFFIX}`
    try {
      const watcher = watch(join(experimentsFolder, name), { persistent: false }, (_event, entry) => {
        if (!entry || entry.toString() === file) changed()
      })
      watcher.on('error', () => forget(name))
      folders.set(name, watcher)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  const followAll = async (): Promise<void> => {
    const names = new Set(await folderNames(experimentsFolder))
    for (const name of folders.keys()) if (!names.has(name)) forget(name)
    names.forEach(follow)
  }
  const stop = (): void => {
    clearTimeout(timer)
    top.close()
    for (const name of [...folders.keys()]) forget(name)
  }
  const fail = (error: unknown): void => {
    stop()
    onStop(error instanceof Error ? error : new Error(String(error)))
  }
  const top = watch(experimentsFolder, { persistent: false }, () => {
    followAll().then(changed, fail)
  })
  top.on('error', fail)
  followAll().catch(fail)
  return stop
}

const homes = async (workspaceDirectory: string): Promise<string[]> => {
  const inside = evalsExperimentsFolder(workspaceDirectory)
  const outside = outsideHomes(workspaceDirectory)
  return [
    ...(await folderNames(inside)).map((name) => join(inside, name)),
    ...(await folderNames(outside)).map((name) => join(outside, name)),
  ]
}

const stampOrder = (stamp: string): number => {
  const suffix = Number(STAMP.exec(stamp)?.[7] ?? 1)
  return (evalsStampTime(stamp) ?? 0) + suffix / 1000
}

const homeRuns = async (home: string, kind: string): Promise<EvalsRunFolder[]> => {
  const parent = join(home, kind)
  return (await folderNames(parent))
    .flatMap((stamp) =>
      evalsStampTime(stamp) === undefined ? [] : [{ home, name: basename(home), folder: join(parent, stamp), stamp }]
    )
    .sort((left, right) => stampOrder(left.stamp) - stampOrder(right.stamp))
}

const runFolders = async (workspaceDirectory: string, kind: string): Promise<EvalsRunFolder[]> =>
  (await Promise.all((await homes(workspaceDirectory)).map((home) => homeRuns(home, kind))))
    .flat()
    .sort((left, right) => stampOrder(left.stamp) - stampOrder(right.stamp))

export const listEvaluationRuns = (workspaceDirectory: string): Promise<EvalsRunFolder[]> =>
  runFolders(workspaceDirectory, RUNS_FOLDER)

export const listEvalsOptimizations = (workspaceDirectory: string): Promise<EvalsRunFolder[]> =>
  runFolders(workspaceDirectory, OPTIMIZATIONS_FOLDER)

export const pruneEvaluationRuns = async (
  home: string,
  kept: readonly string[],
  keep = KEPT_EVALUATION_RUNS
): Promise<number> => {
  const runs = await homeRuns(home, RUNS_FOLDER)
  const protectedFolders = new Set(kept.map((path) => resolve(path)))
  const old = runs
    .slice(0, Math.max(0, runs.length - keep))
    .filter(
      ({ folder, stamp }) =>
        !protectedFolders.has(resolve(folder)) && !existsSync(evaluationRunFiles(home, stamp).record)
    )
  await Promise.all(old.map(({ folder }) => rm(folder, { recursive: true, force: true })))
  return old.length
}
