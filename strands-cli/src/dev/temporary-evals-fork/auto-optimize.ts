import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { errorMessage } from '../../terminal/text.js'
import type { DevChatJob, DevChatNotice, DevChatTurnEnd } from '../../ui/chat/types.js'
import { isRecord } from '../../values.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import type { TemporaryHost } from './host.js'
import { Store } from './jobs.js'
import { temporaryStateFolder } from './layout.js'

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
export interface AutoOptimizeGate {
  /** An optimization is running, or the edits of a finished one wait for the developer's answer. */
  busy(): boolean
  /** Resolves once none is, and rejects when the signal aborts first. */
  idle(signal: AbortSignal): Promise<void>
}

/** What the background work shows of itself while it goes. */
export interface AutoOptimizeActivity {
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
