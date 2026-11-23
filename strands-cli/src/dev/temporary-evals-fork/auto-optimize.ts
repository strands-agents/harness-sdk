import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DevChatCommandContext, DevChatTurnEnd } from '../../ui/chat/types.js'
import { isRecord } from '../../values.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import type { TemporaryHost } from './host.js'
import { temporaryStateFolder } from './layout.js'

const STATE_FILE = 'auto-optimize.json'

export interface AutoOptimizeStatus {
  /** An optimization starts by itself every this many chat turns; 0 means it is off. */
  readonly everyTurns: number
  /** The chat turns counted since the last one it started, or since the cadence was set. */
  readonly turnsSince: number
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
}

const REQUEST = 'auto-optimize'

/** The request that strands dev sends for the developer when a run is due. /optimize answers it with its own workflow. */
export const autoOptimizeRequest = (everyTurns: number): string =>
  `/optimize ${REQUEST}: ${everyTurns} chat turns since the last one`

/** Whether what follows /optimize is that request, typed or sent. */
export const isAutoOptimizeRequest = (request: string): boolean => request.trimStart().toLowerCase().startsWith(REQUEST)

const isChatMessage = (prompt: string): boolean => prompt.trim() !== '' && !/^[!/$]/u.test(prompt.trimStart())

/**
 * Counts the chat turns of a workspace and, every so many of them, asks the agent to make an experiment from the
 * chats and optimize on it. The count is kept on disk, so it carries on when strands dev opens again.
 */
export class TemporaryAutoOptimize {
  private count: Count | undefined
  private work: Promise<void> = Promise.resolve()

  constructor(
    private readonly host: TemporaryHost,
    private readonly gate: AutoOptimizeGate
  ) {}

  async status(): Promise<AutoOptimizeStatus> {
    await this.work
    const everyTurns = this.everyTurns()
    const { turns, every } = await this.counted()
    return { everyTurns, turnsSince: every === everyTurns ? turns : 0 }
  }

  /** A turn of the developer's ended with a reply. One at a time, so two turns cannot both find the run due. */
  turnEnded(context: DevChatCommandContext, turn: DevChatTurnEnd): Promise<void> {
    this.work = this.work.then(() => this.countTurn(context, turn)).catch(() => undefined)
    return this.work
  }

  private everyTurns(): number {
    return this.host().settings?.().autoOptimize ?? 0
  }

  private async countTurn(context: DevChatCommandContext, turn: DevChatTurnEnd): Promise<void> {
    const every = this.everyTurns()
    const counted = await this.counted()
    // Off, or the cadence is not the one counted under: the count starts again after this turn. So the turn that
    // sets a cadence is not one of its turns, and a new cadence never starts a run with the turns of the old one.
    if (every === 0 || counted.every !== every) return this.remember({ turns: 0, every })
    const turns = counted.turns + (isChatMessage(turn.prompt) ? 1 : 0)
    // A run that is due waits for the run before it to be done with.
    if (turns < every || this.gate.busy()) return this.remember({ turns, every })
    await this.remember({ turns: 0, every })
    context.submit(autoOptimizeRequest(every))
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
