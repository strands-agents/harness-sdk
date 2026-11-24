import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { DevWorkspace } from '../workspace.js'
import type { AutoOptimizeRun } from './auto-optimize.js'
import { spawnAutoOptimizeWorker, type AutoOptimizeWorker } from './auto-optimize-worker.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import { readTemporaryExperimentFile } from './experiment-files.js'
import { temporaryExperimentFile, temporaryStateFolder } from './layout.js'
import type { TemporarySessionHistory } from './session-converter.js'

/** With fewer cases the optimizer has nothing to train, validate, and test on. */
const FEWEST_CASES = 3

const TASK =
  'strands dev runs you in the background, for the developer of this agent. They turned on auto-optimize, and it ' +
  'is due. Your whole task is to make one experiment from their chats with this agent, by the skill and the rules ' +
  'below. When the file is saved and valid, you are done: strands dev starts the optimization itself.'

export interface AutoOptimizeRunOptions {
  readonly workspace: DevWorkspace
  readonly history: Pick<TemporarySessionHistory, 'unattendedConverter'>
  /** Starts an optimization of the saved experiment with the defaults of its plan. */
  readonly start: (experiment: string) => Promise<unknown>
  readonly worker?: AutoOptimizeWorker
  readonly now?: () => Date
}

const two = (value: number): string => String(value).padStart(2, '0')

const stamp = (at: Date): string =>
  `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`

/** A name no experiment has yet: two runs in one minute do not write the same file. */
const freshName = (directory: string, at: Date): string => {
  const base = `history-${stamp(at)}`
  let name = base
  for (let next = 2; existsSync(dirname(temporaryExperimentFile(directory, name))); next++) name = `${base}-${next}`
  return name
}

export const autoOptimizeLog = (directory: string, experiment: string): string =>
  join(temporaryStateFolder(directory), 'auto-optimize', `${experiment}.log`)

const casesOf = async (file: string): Promise<number | undefined> => {
  if (!existsSync(file)) return undefined
  return (await readTemporaryExperimentFile(file)).raw.cases.length
}

/**
 * What auto-optimize does when it is due. An agent in a process of its own makes the experiment, because that takes
 * a model; strands dev then starts the optimizer on it, because that takes none. So the developer's chat is asked
 * nothing and holds none of it.
 */
export const autoOptimizeRun =
  ({
    workspace,
    history,
    start,
    worker = spawnAutoOptimizeWorker,
    now = (): Date => new Date(),
  }: AutoOptimizeRunOptions): AutoOptimizeRun =>
  async ({ signal, building, idle }) => {
    const directory = temporaryWorkspaceDirectory(workspace)
    const experiment = freshName(directory, now())
    const log = autoOptimizeLog(directory, experiment)
    building(experiment, log)
    const guide = await history.unattendedConverter({ name: experiment, fewestCases: FEWEST_CASES })
    signal.throwIfAborted()
    const { code } = await worker({ workspace, prompt: `${TASK}\n\n${guide}`, log, signal })
    signal.throwIfAborted()
    const cases = await casesOf(temporaryExperimentFile(directory, experiment))
    if (cases === undefined)
      throw new Error(
        code === 0
          ? `the chats gave no experiment · the agent's reasons are in ${log}`
          : `the agent that makes the experiment stopped with code ${code} · see ${log}`
      )
    if (cases < FEWEST_CASES)
      throw new Error(`${experiment} has ${cases} of the ${FEWEST_CASES} cases an optimization needs`)
    await idle()
    await start(experiment)
    return { experiment, cases }
  }
