import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob, DevChatNotice, DevChatTurnEnd } from '../../ui/chat/types.js'
import { isRecord } from '../../values.js'
import { DEV_PROJECT_PREPARED } from '../runtime.js'
import type { DevWorkspace } from '../workspace.js'
import { stopTemporaryProcessGroup, temporaryWorkspaceDirectory } from './evals-process.js'
import { readTemporaryExperimentFile } from './experiment.js'
import type { TemporaryHost } from './host.js'
import { Store } from './jobs.js'
import { temporaryExperimentFile, temporaryStateFolder } from './layout.js'
import type { TemporarySessionHistory } from './session-converter.js'

const STATE_FILE = 'auto-optimize.json'
const OFF_CHECK_MS = 1000

export const AUTO_OPTIMIZE_JOB = 'auto-optimize'

export interface AutoOptimizeStatus {
  /** An optimization starts by itself every this many chat turns; 0 means it is off. */
  readonly everyTurns: number
  /** The chat turns counted since the last one it started, or since the cadence was set. */
  readonly turnsSince: number
  /** The experiment that a background agent is making from the chats right now. */
  readonly building?: string
  /** Where that agent writes what it does. */
  readonly log?: string
}

/** What is kept on disk between turns. */
interface Count {
  readonly turns: number
  /** The cadence the turns were counted under. A different cadence starts the count again. */
  readonly every: number
}

const NOTHING_COUNTED: Count = { turns: 0, every: 0 }

/** What stands in the way of a run that is due, if anything. */
interface AutoOptimizeGate {
  /** An optimization is running, or the edits of a finished one wait for the developer's answer. */
  busy(): boolean
  /** Resolves once none is, and rejects when the signal aborts first. */
  idle(signal: AbortSignal): Promise<void>
}

/** What the background work shows of itself while it goes. */
interface AutoOptimizeActivity {
  /** The experiment that is being made from the chats, once it has a name. */
  readonly building?: string
  readonly log?: string
}

export interface AutoOptimizeOutcome {
  readonly experiment: string
  readonly cases: number
}

/**
 * Makes an experiment from the chats and starts an optimization on it, away from the developer's chat. It rejects
 * with the reason when there is nothing to optimize on.
 */
export type AutoOptimizeRun = (work: {
  readonly signal: AbortSignal
  building(experiment: string, log: string): void
  /**
   * Resolves when no other optimization is in the way. One the developer started while the experiment was made
   * comes first, and its edits get their answer before the next run changes the agent again.
   */
  idle(): Promise<void>
}) => Promise<AutoOptimizeOutcome>

const isChatMessage = (prompt: string): boolean => prompt.trim() !== '' && !/^[!/$]/u.test(prompt.trimStart())

export const autoOptimizeJobs = ({ building }: AutoOptimizeActivity): readonly DevChatJob[] =>
  building ? [{ id: AUTO_OPTIMIZE_JOB, label: `auto-optimize · making ${building} from your chats` }] : []

/**
 * Counts the chat turns of a workspace and, every so many of them, has an experiment made from the chats and an
 * optimization started on it. None of that happens in the chat: the chat gets one notice, and the jobs line shows
 * the work. The count is kept on disk, so it carries on when strands dev opens again.
 */
export class TemporaryAutoOptimize extends Store<AutoOptimizeActivity> {
  private count: Count | undefined
  private work: Promise<void> = Promise.resolve()
  private running:
    | {
        readonly stop: AbortController
        readonly done: Promise<void>
        readonly began: string
        notice: DevChatNotice | undefined
      }
    | undefined

  constructor(
    private readonly host: TemporaryHost,
    private readonly gate: AutoOptimizeGate
  ) {
    super({})
  }

  async status(): Promise<AutoOptimizeStatus> {
    await this.work
    const everyTurns = this.everyTurns()
    const { turns, every } = await this.counted()
    return { everyTurns, turnsSince: every === everyTurns ? turns : 0, ...this.snapshot() }
  }

  /** A turn of the developer's ended with a reply. One at a time, so two turns cannot both find the run due. */
  turnEnded(turn: DevChatTurnEnd, run: AutoOptimizeRun): Promise<void> {
    this.work = this.work.then(() => this.countTurn(turn, run)).catch(() => undefined)
    return this.work
  }

  /** Resolves when the background work that is going, if any, is over. */
  async settled(): Promise<void> {
    await this.work
    await this.running?.done
    await this.work
  }

  private everyTurns(): number {
    return this.host().settings?.().autoOptimize ?? 0
  }

  private async countTurn(turn: DevChatTurnEnd, run: AutoOptimizeRun): Promise<void> {
    const every = this.everyTurns()
    const counted = await this.counted()
    // Turned off: the agent that was at work for it stops too.
    if (every === 0) this.running?.stop.abort()
    // Off, or the cadence is not the one counted under: the count starts again after this turn. So the turn that
    // sets a cadence is not one of its turns, and a new cadence never starts a run with the turns of the old one.
    if (every === 0 || counted.every !== every) return this.remember({ turns: 0, every })
    const turns = counted.turns + (isChatMessage(turn.prompt) ? 1 : 0)
    await this.remember({ turns, every })
    // A run that is due waits for the run before it to be done with.
    if (turns < every || this.running || this.gate.busy()) return
    this.begin(turns, run)
  }

  /**
   * The count starts again when the work is over, not when it begins: strands dev may close in between, and the
   * work is then due again at the next turn.
   */
  private begin(turns: number, run: AutoOptimizeRun): void {
    const stop = new AbortController()
    const began = `auto-optimize · ${turns} chat turns since the last one · making an experiment from your chats in the background`
    // The notice is the one of the chat that is open when the work ends, which a reload may have replaced.
    const tell = (status: 'success' | 'error', text: string): void => this.running?.notice?.update(status, text)
    const done = run({
      signal: stop.signal,
      building: (building, log): void => this.set({ building, log }),
      idle: (): Promise<void> => this.gate.idle(stop.signal),
    })
      .then(
        ({ experiment, cases }) =>
          tell(
            'success',
            `auto-optimize · made ${experiment} from your chats (${cases} cases) · optimizing on it in the background`
          ),
        (error: unknown) =>
          tell(
            'error',
            stop.signal.aborted
              ? 'auto-optimize · stopped, as it was turned off'
              : `auto-optimize · no optimization started · ${errorMessage(error)}`
          )
      )
      .finally(() => {
        clearInterval(watch)
        this.running = undefined
        this.set({})
        this.work = this.work.then(() => this.startAgain()).catch(() => undefined)
      })
    // Turned off in the settings panel, the work stops within a moment and not at the end of the next turn.
    const watch = setInterval(() => {
      if (this.everyTurns() === 0) stop.abort()
    }, OFF_CHECK_MS)
    watch.unref()
    this.running = { stop, done, began, notice: this.host().context?.report('running', began) }
  }

  /**
   * The setting was just changed. When that turned it off, the work that goes stops before this returns, and the
   * experiment it was making is named.
   */
  async settingChanged(): Promise<string | undefined> {
    const work = this.running
    if (!work || this.everyTurns() !== 0) return undefined
    const { building } = this.snapshot()
    work.stop.abort()
    await work.done
    return building
  }

  /**
   * A chat opened, as after a reload of the agent. The notice of work that is going went to the chat before it, so
   * this one gets its own, and the end is told here.
   */
  reannounce(): void {
    const work = this.running
    if (work) work.notice = this.host().context?.report('running', work.began)
  }

  private async startAgain(): Promise<void> {
    await this.remember({ turns: 0, every: (await this.counted()).every })
  }

  private path(): string {
    return join(temporaryStateFolder(temporaryWorkspaceDirectory(this.host().workspace)), STATE_FILE)
  }

  private async counted(): Promise<Count> {
    if (this.count) return this.count
    let saved: unknown
    try {
      saved = JSON.parse(await readFile(this.path(), 'utf8'))
    } catch {
      saved = undefined
    }
    const whole = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0
    this.count =
      isRecord(saved) && whole(saved.turns) && whole(saved.every)
        ? { turns: saved.turns, every: saved.every }
        : NOTHING_COUNTED
    return this.count
  }

  private async remember(count: Count): Promise<void> {
    const { turns, every } = await this.counted()
    if (turns === count.turns && every === count.every) return
    this.count = count
    await mkdir(dirname(this.path()), { recursive: true })
    await writeFile(this.path(), `${JSON.stringify(count)}\n`)
  }
}

export interface AutoOptimizeWorkerRequest {
  readonly workspace: DevWorkspace
  /** The whole task of the agent. Nobody answers it, and its reply is read by nobody but the log. */
  readonly prompt: string
  /** The file that takes everything the agent prints. */
  readonly log: string
  readonly signal: AbortSignal
}

interface AutoOptimizeWorkerExit {
  readonly code: number
}

/** Runs the agent of the workspace on one task, in a process of its own, and resolves when that process ends. */
export type AutoOptimizeWorker = (request: AutoOptimizeWorkerRequest) => Promise<AutoOptimizeWorkerExit>

const GROUPED = process.platform !== 'win32'

/**
 * How this strands was started, so the worker is the same build: the runtime with its flags and the script it was
 * given, which may be a link without an extension. A build that is one binary has no script.
 */
export const strandsCommandOf = (
  entry: string | undefined,
  runtime: string,
  runtimeFlags: readonly string[]
): readonly string[] => (entry && entry !== runtime ? [runtime, ...runtimeFlags, entry] : [runtime])

const strandsCommand = (): readonly string[] => strandsCommandOf(process.argv[1], process.execPath, process.execArgv)

/**
 * The arguments of the worker: the agent of the workspace answers one request and exits. It keeps no session and no
 * memory, so its work is not one of the chats that the next experiment is made from.
 */
export const autoOptimizeWorkerArguments = (workspace: DevWorkspace): readonly string[] => [
  'dev',
  '--workspace',
  temporaryWorkspaceDirectory(workspace),
  '--print',
  '--session',
  'off',
  '--memory',
  'off',
]

/** A worker that is started with this command, which a test replaces with a program of its own. */
export const autoOptimizeWorker =
  (program: () => readonly string[] = strandsCommand): AutoOptimizeWorker =>
  async ({ workspace, prompt, log, signal }) => {
    await mkdir(dirname(log), { recursive: true })
    const [command, ...leading] = program()
    const output = openSync(log, 'a')
    try {
      return await new Promise<AutoOptimizeWorkerExit>((resolveExit, rejectExit) => {
        const child = spawn(command!, [...leading, ...autoOptimizeWorkerArguments(workspace)], {
          cwd: workspace.root,
          // The strands dev that starts it has the project open, so it is installed and built already.
          env: { ...process.env, [DEV_PROJECT_PREPARED]: '1' },
          // The request goes in on stdin: it is long, and a command line has a limit.
          stdio: ['pipe', output, output],
          // A group of its own, so the commands that the agent runs stop with it.
          detached: GROUPED,
          windowsHide: true,
        })
        const stop = (): void => {
          if (child.pid === undefined || child.exitCode !== null) return
          if (GROUPED) stopTemporaryProcessGroup(child.pid)
          else child.kill('SIGTERM')
        }
        // The agent works for this strands dev, so it does not outlive it.
        process.once('exit', stop)
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
        const settle = (): void => {
          process.removeListener('exit', stop)
          signal.removeEventListener('abort', stop)
        }
        child.once('error', (error) => {
          settle()
          rejectExit(error)
        })
        child.once('close', (code) => {
          settle()
          resolveExit({ code: code ?? 1 })
        })
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(prompt)
        // It must not keep strands dev open after the developer leaves.
        child.unref()
      })
    } finally {
      closeSync(output)
    }
  }

const spawnAutoOptimizeWorker: AutoOptimizeWorker = autoOptimizeWorker()

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

const autoOptimizeLog = (directory: string, experiment: string): string =>
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
