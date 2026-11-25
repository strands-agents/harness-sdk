import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  autoOptimizeJobs,
  autoOptimizeRun,
  autoOptimizeWorker,
  autoOptimizeWorkerArguments,
  strandsCommandOf,
  EvalsAutoOptimize,
  type AutoOptimizeOutcome,
  type AutoOptimizeRun,
  type AutoOptimizeWorker,
  type AutoOptimizeWorkerRequest,
} from '../../../src/dev/evals/auto-optimize.js'
import type { EvalsSessionHost } from '../../../src/dev/evals/host.js'
import type { UnattendedConversion } from '../../../src/dev/evals/session-converter.js'
import type { DevChatCommandContext } from '../../../src/ui/chat/types.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const workspaceIn = (root: string): DevWorkspace => ({
  directory: join(root, 'strands-dev'),
  root,
  entrypoint: join(root, 'agent.ts'),
  config: { version: 1, name: 'desk', language: 'typescript', entrypoint: 'agent.ts', origin: { kind: 'discovered' } },
})

const MADE: AutoOptimizeOutcome = { experiment: 'history-20261123-1502', cases: 5 }

/** A chat as the dev sessions see it: what it was told, and nothing else it could be asked to do. */
const chat = () => {
  const notices: { status: string; text: string }[] = []
  const context: DevChatCommandContext = {
    report: (status, text) => {
      const notice = { status, text }
      notices.push(notice)
      return { update: (next, changed): void => void Object.assign(notice, { status: next, text: changed }) }
    },
    openPanel: vi.fn(() => true),
  }
  return { context, notices }
}

/**
 * A workspace whose auto-optimize setting and whose running optimization the test can change as turns go by. The
 * background work is the test's: it ends when the test says so.
 */
const counting = async (every = 5, root?: string) => {
  const workspace = workspaceIn(root ?? (await temporaryDirectory()))
  const state = { every, busy: false, chat: chat() }
  const host = (): EvalsSessionHost => ({
    workspace,
    agent: () => ({}),
    settings: () => ({ autoAcceptOptimizationResults: false, autoOptimize: state.every }),
    context: state.chat.context,
  })
  const auto = new EvalsAutoOptimize(host, {
    busy: () => state.busy,
    idle: () => Promise.resolve(),
  })
  const works: { signal: AbortSignal; end(outcome?: AutoOptimizeOutcome): void; fail(error: Error): void }[] = []
  const run = vi.fn<AutoOptimizeRun>(
    ({ signal, building }) =>
      new Promise((end, fail) => {
        building(MADE.experiment, '/w/strands-dev/tmp/.state/auto-optimize/history-20261123-1502.log')
        works.push({ signal, end: (outcome = MADE) => end(outcome), fail })
        signal.addEventListener('abort', () => fail(new Error('stopped')), { once: true })
      })
  )
  const turns = async (...prompts: string[]): Promise<void> => {
    for (const prompt of prompts) await auto.turnEnded({ prompt }, run)
  }
  const file = join(workspace.directory!, 'tmp', '.state', 'auto-optimize.json')
  // In a workspace that has counted nothing yet, the cadence was set in a turn, and that turn is not counted.
  if (every > 0 && root === undefined) await turns(`optimize every ${every} turns from my history`)
  return { auto, state, run, works, turns, file, root: workspace.root }
}

const FIVE = ['one', 'two', 'three', 'four', 'five']

describe('auto-optimize every N turns', () => {
  it('shouldStartItsWorkInTheBackgroundWhenThatManyChatTurnsHavePassed', async () => {
    const { auto, run, turns } = await counting(5)

    await turns('one', 'two', 'three', 'four')
    const before = [run.mock.calls.length, await auto.status()]
    await turns('five')

    expect(before).toEqual([0, { everyTurns: 5, turnsSince: 4 }])
    expect(run).toHaveBeenCalledOnce()
  })

  it('shouldTellTheChatOnlyOneNoticeThatItUpdates', async () => {
    const { auto, state, works, turns } = await counting(5)

    await turns(...FIVE)
    const whileItWorks = state.chat.notices.map((notice) => ({ ...notice }))
    works[0]!.end()
    await auto.settled()

    expect(whileItWorks).toEqual([
      {
        status: 'running',
        text: 'auto-optimize · 5 chat turns since the last one · making an experiment from your chats in the background',
      },
    ])
    expect(state.chat.notices).toEqual([
      {
        status: 'success',
        text: 'auto-optimize · made history-20261123-1502 from your chats (5 cases) · optimizing on it in the background',
      },
    ])
  })

  it('shouldShowTheWorkOnTheJobsLineWhileItGoesAndTakeItOffWhenItEnds', async () => {
    const { auto, works, turns } = await counting(5)

    await turns(...FIVE)
    const whileItWorks = [autoOptimizeJobs(auto.snapshot()), await auto.status()]
    works[0]!.end()
    await auto.settled()

    expect(whileItWorks).toEqual([
      [{ id: 'auto-optimize', label: 'auto-optimize · making history-20261123-1502 from your chats' }],
      {
        everyTurns: 5,
        turnsSince: 5,
        building: 'history-20261123-1502',
        log: '/w/strands-dev/tmp/.state/auto-optimize/history-20261123-1502.log',
      },
    ])
    expect(autoOptimizeJobs(auto.snapshot())).toEqual([])
    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 0 })
  })

  it('shouldSayWhyNoOptimizationStartedAndCountFromNoTurnsAgain', async () => {
    const { auto, state, run, works, turns } = await counting(5)

    await turns(...FIVE)
    works[0]!.fail(new Error('history-20261123-1502 has 2 of the 3 cases an optimization needs'))
    await auto.settled()
    await turns('one')

    expect(state.chat.notices).toEqual([
      {
        status: 'error',
        text: 'auto-optimize · no optimization started · history-20261123-1502 has 2 of the 3 cases an optimization needs',
      },
    ])
    // A failure is not tried again at every turn: each try is paid.
    expect(run).toHaveBeenCalledOnce()
    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 1 })
  })

  it('shouldStartNoSecondWorkWhileOneGoes', async () => {
    const { auto, run, works, turns } = await counting(5)

    await turns(...FIVE, ...FIVE)
    const whileItWorks = run.mock.calls.length
    works[0]!.end()
    await auto.settled()
    await turns(...FIVE)

    expect(whileItWorks).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('shouldKeepTheWorkDueWhenStrandsDevClosesBeforeItEnds', async () => {
    const first = await counting(5)
    await first.turns(...FIVE)

    // Closed with the work unfinished: the count on disk still says a run is due.
    const again = await counting(5, first.root)
    await again.turns('/experiment')

    expect(JSON.parse(await readFile(first.file, 'utf8'))).toEqual({ turns: 5, every: 5 })
    expect(again.run).toHaveBeenCalledOnce()
  })

  it('shouldStopTheWorkWhenItIsTurnedOffAndSaySo', async () => {
    const { auto, state, works, turns } = await counting(5)
    await turns(...FIVE)

    state.every = 0
    await turns('turn auto-optimize off')
    await auto.settled()

    expect(works[0]!.signal.aborted).toBe(true)
    expect(state.chat.notices).toEqual([{ status: 'error', text: 'auto-optimize · stopped, as it was turned off' }])
    expect(await auto.status()).toEqual({ everyTurns: 0, turnsSince: 0 })
  })

  it('shouldStopTheWorkAtOnceAndNameItsExperimentWhenAToolTurnedItOff', async () => {
    const { auto, state, works, turns } = await counting(5)
    await turns(...FIVE)

    const whileOn = await auto.settingChanged()
    state.every = 0
    const stopped = await auto.settingChanged()

    expect(whileOn).toBeUndefined()
    expect(stopped).toBe('history-20261123-1502')
    expect(works[0]!.signal.aborted).toBe(true)
    expect(state.chat.notices).toEqual([{ status: 'error', text: 'auto-optimize · stopped, as it was turned off' }])
    expect(await auto.status()).toEqual({ everyTurns: 0, turnsSince: 0 })
  })

  it('shouldStopTheWorkWithinAMomentWhenTheSettingsPanelTurnedItOff', async () => {
    const { auto, state, works, turns } = await counting(5)
    await turns(...FIVE)

    state.every = 0
    await auto.settled()

    // No turn ended and no tool ran: the setting alone stops it.
    expect(works[0]!.signal.aborted).toBe(true)
    expect(state.chat.notices).toEqual([{ status: 'error', text: 'auto-optimize · stopped, as it was turned off' }])
  })

  it('shouldTellTheChatThatAReloadOpenedOfTheWorkThatGoesAndOfItsEnd', async () => {
    const { auto, state, works, turns } = await counting(5)
    await turns(...FIVE)
    const reloaded = chat()

    state.chat = reloaded
    auto.reannounce()
    const whileItWorks = reloaded.notices.map(({ status }) => status)
    works[0]!.end()
    await auto.settled()

    expect(whileItWorks).toEqual(['running'])
    expect(reloaded.notices).toEqual([
      {
        status: 'success',
        text: 'auto-optimize · made history-20261123-1502 from your chats (5 cases) · optimizing on it in the background',
      },
    ])
  })

  it('shouldCountWhatTheDeveloperSaidToTheAgentAndNotTheCommands', async () => {
    const { auto, run, turns } = await counting(5)

    await turns('/experiment', '/optimize refunds', '!ls', '$deploy', '  ', 'what does this agent do?')

    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it('shouldCountNothingAndWriteNothingWhileItIsOff', async () => {
    const { auto, run, turns, file } = await counting(0)

    await turns(...FIVE, ...FIVE)

    expect(run).not.toHaveBeenCalled()
    expect(await auto.status()).toEqual({ everyTurns: 0, turnsSince: 0 })
    expect(existsSync(file)).toBe(false)
  })

  it('shouldNotCountTheTurnThatSetTheCadence', async () => {
    const { auto, state, run, turns, file } = await counting(0)

    state.every = 5
    await turns('optimize every 5 turns from my history')
    const afterTheTurnThatSetIt = await auto.status()
    const saved = JSON.parse(await readFile(file, 'utf8')) as unknown
    await turns('one', 'two', 'three', 'four')
    const beforeTheFifth = run.mock.calls.length
    await turns('five')

    // The agent tells the developer that the first run comes 5 turns from now, so the turn that set it is not one.
    expect(afterTheTurnThatSetIt).toEqual({ everyTurns: 5, turnsSince: 0 })
    expect(saved).toEqual({ turns: 0, every: 5 })
    expect(beforeTheFifth).toBe(0)
    expect(run).toHaveBeenCalledOnce()
  })

  it('shouldStartFromNoTurnsWhenItIsTurnedOnAgain', async () => {
    const { auto, state, run, turns } = await counting(5)
    await turns('one', 'two', 'three')

    state.every = 0
    await turns('turn it off')
    state.every = 5
    await turns('turn it on again', 'five', 'six')

    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 2 })
    expect(run).not.toHaveBeenCalled()
  })

  it('shouldCarryTheCountOverWhenStrandsDevOpensAgain', async () => {
    const first = await counting(5)
    await first.turns('one', 'two', 'three')
    expect(JSON.parse(await readFile(first.file, 'utf8'))).toEqual({ turns: 3, every: 5 })

    const again = await counting(5, first.root)
    await again.turns('four', 'five')

    expect(again.run).toHaveBeenCalledOnce()
    expect(first.run).not.toHaveBeenCalled()
  })

  it('shouldWaitWhileAnOptimizationRunsOrItsEditsWaitAndThenStart', async () => {
    const { auto, state, run, turns } = await counting(5)
    state.busy = true

    await turns(...FIVE, 'six')
    const whileBusy = [run.mock.calls.length, (await auto.status()).turnsSince]
    state.busy = false
    // The run is due already, so the end of any turn starts it, also one that is not counted.
    await turns('/experiment refunds')

    expect(whileBusy).toEqual([0, 6])
    expect(run).toHaveBeenCalledOnce()
  })

  it('shouldStartTheCountAgainWhenTheCadenceChangesAndStartNoRunWithTheTurnsOfTheOldOne', async () => {
    const { auto, state, run, turns } = await counting(20)
    await turns(...FIVE, 'six')

    state.every = 5
    // Six turns are more than the new five, but they were counted towards a run every twenty.
    const reported = await auto.status()
    await turns('make it every 5')
    const afterTheChange = [run.mock.calls.length, await auto.status()]
    await turns(...FIVE)

    expect(reported).toEqual({ everyTurns: 5, turnsSince: 0 })
    expect(afterTheChange).toEqual([0, { everyTurns: 5, turnsSince: 0 }])
    expect(run).toHaveBeenCalledOnce()
  })

  it('shouldStartTheCountAgainWhenTheSavedCountNamesNoCadence', async () => {
    const first = await counting(5)
    await first.turns('one', 'two', 'three')
    await writeFile(first.file, '{"turns":4}\n')

    const again = await counting(5, first.root)
    await again.turns('four')

    expect(again.run).not.toHaveBeenCalled()
    expect(await again.auto.status()).toEqual({ everyTurns: 5, turnsSince: 0 })
  })

  it('shouldStartOneWorkWhenTwoTurnsEndTogether', async () => {
    const { auto, run, turns } = await counting(5)
    await turns('one', 'two', 'three', 'four')

    await Promise.all([auto.turnEnded({ prompt: 'five' }, run), auto.turnEnded({ prompt: 'six' }, run)])

    expect(run).toHaveBeenCalledOnce()
  })
})

const NOW = new Date(2026, 10, 23, 15, 2)
const NAME = 'history-20261123-1502'

const experimentWith = (cases: number): string =>
  JSON.stringify({
    cases: Array.from({ length: cases }, (_, index) => ({ name: `c${index}`, input: 'hi', expected_assertion: 'ok' })),
    evaluators: [{ evaluator_type: 'OutputEvaluator' }],
  })

/** The background work with an agent that the test plays: it saves the cases it is told to, or none. */
const runSetup = async (made: { cases?: number; code?: number } = { cases: 5 }) => {
  const root = await temporaryDirectory()
  const workspace = workspaceIn(root)
  const file = (name: string): string => join(root, 'strands-dev', 'experiments', name, `${name}.json`)
  const log = join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', `${NAME}.log`)
  const order: string[] = []
  const requests: AutoOptimizeWorkerRequest[] = []
  const worker = vi.fn<AutoOptimizeWorker>(async (request) => {
    order.push('agent')
    requests.push(request)
    const name = /save it as (\S+)/u.exec(request.prompt)![1]!
    if (made.cases !== undefined) {
      await mkdir(dirname(file(name)), { recursive: true })
      await writeFile(file(name), experimentWith(made.cases))
    }
    return { code: made.code ?? 0 }
  })
  const unattendedConverter = vi.fn(async ({ name }: UnattendedConversion) => `the skill: save it as ${name}`)
  const start = vi.fn(async (_experiment: string) => {
    order.push('optimizer')
    return 'run-1'
  })
  const idle = vi.fn(async (): Promise<void> => {
    order.push('idle')
  })
  const building = vi.fn()
  const stop = new AbortController()
  const run = autoOptimizeRun({
    workspace,
    history: { unattendedConverter },
    start,
    worker,
    now: () => NOW,
  })
  const go = () => run({ signal: stop.signal, building, idle })
  return { file, log, worker, requests, unattendedConverter, start, idle, building, stop, order, go }
}

describe('what auto-optimize does in the background when it is due', () => {
  it('shouldHaveAnAgentMakeTheExperimentAndThenStartTheOptimizerItself', async () => {
    const { go, order, start } = await runSetup({ cases: 5 })

    const outcome = await go()

    expect(outcome).toEqual({ experiment: NAME, cases: 5 })
    // The optimizer is started by strands dev and not by the agent: no model decides whether a paid run may begin.
    expect(order).toEqual(['agent', 'idle', 'optimizer'])
    expect(start).toHaveBeenCalledExactlyOnceWith(NAME)
  })

  it('shouldGiveTheAgentTheSkillForItsExperimentWhenItStarts', async () => {
    const { go, requests, unattendedConverter, log } = await runSetup()

    await go()

    expect(unattendedConverter).toHaveBeenCalledExactlyOnceWith({ name: NAME, fewestCases: 3 })
    expect(requests[0]!.prompt).toContain('strands dev runs you in the background')
    expect(requests[0]!.prompt).toContain('strands dev starts the optimization itself')
    expect(requests[0]!.prompt.endsWith(`the skill: save it as ${NAME}`)).toBe(true)
    expect(requests[0]!.log).toBe(log)
  })

  it('shouldNameTheExperimentAndItsLogBeforeTheAgentStarts', async () => {
    const { go, building, worker, log } = await runSetup()

    await go()

    expect(building).toHaveBeenCalledExactlyOnceWith(NAME, log)
    expect(building.mock.invocationCallOrder[0]).toBeLessThan(worker.mock.invocationCallOrder[0]!)
  })

  it('shouldTakeANameThatNoExperimentHasWhenOneWasMadeInTheSameMinute', async () => {
    const { go, file } = await runSetup()
    await mkdir(dirname(file(NAME)), { recursive: true })

    const outcome = await go()

    expect(outcome.experiment).toBe(`${NAME}-2`)
  })

  it('shouldStartNoOptimizerWhenTheChatsGaveTooFewCases', async () => {
    const { go, start } = await runSetup({ cases: 2 })

    await expect(go()).rejects.toThrow(`${NAME} has 2 of the 3 cases an optimization needs`)
    expect(start).not.toHaveBeenCalled()
  })

  it('shouldPointAtTheLogWhenTheAgentSavedNoExperiment', async () => {
    const { go, start, log } = await runSetup({})

    await expect(go()).rejects.toThrow(`the chats gave no experiment · the agent's reasons are in ${log}`)
    expect(start).not.toHaveBeenCalled()
  })

  it('shouldGiveTheExitCodeWhenTheAgentFailedBeforeItSavedAnything', async () => {
    const { go, log } = await runSetup({ code: 1 })

    await expect(go()).rejects.toThrow(`the agent that makes the experiment stopped with code 1 · see ${log}`)
  })

  it('shouldStartNoOptimizerWhenItWasStoppedWhileTheAgentWorked', async () => {
    const { go, stop, start, worker } = await runSetup()
    worker.mockImplementationOnce(async () => {
      stop.abort()
      return { code: 143 }
    })

    await expect(go()).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
  })

  it('shouldWaitForAnOptimizationThatTheDeveloperStartedMeanwhileBeforeItStartsItsOwn', async () => {
    const { go, idle, start } = await runSetup()
    let free!: () => void
    idle.mockImplementationOnce(() => new Promise<void>((resolve) => (free = (): void => resolve())))

    const going = go()
    await vi.waitFor(() => expect(idle).toHaveBeenCalled())
    const whileTheOtherRuns = start.mock.calls.length
    free()
    await going

    expect(whileTheOtherRuns).toBe(0)
    expect(start).toHaveBeenCalledOnce()
  })
})

const PROGRAM = fileURLToPath(new URL('../../fixtures/auto-optimize-worker.mjs', import.meta.url))

const workerSetup = async () => {
  const root = await temporaryDirectory()
  const workspace = workspaceIn(root)
  const log = join(root, 'strands-dev', 'tmp', '.state', 'auto-optimize', 'history.log')
  const worker = autoOptimizeWorker(() => [process.execPath, PROGRAM])
  return { root, workspace, log, worker }
}

describe('the process that auto-optimize works in', () => {
  it('shouldRunTheAgentOfTheWorkspaceOnOneRequestWithoutASessionOrMemory', () => {
    const workspace = workspaceIn('/w')

    // Its work must not be saved as a chat: the next experiment would be made from it.
    expect(autoOptimizeWorkerArguments(workspace)).toEqual([
      'dev',
      '--workspace',
      expect.stringMatching(/strands-dev$/u),
      '--print',
      '--session',
      'off',
      '--memory',
      'off',
    ])
  })

  it.each([
    [
      ['/repo/strands-cli/bin/strands.js', '/usr/bin/node', []],
      ['/usr/bin/node', '/repo/strands-cli/bin/strands.js'],
    ],
    [
      ['/repo/strands-cli/src/main.ts', '/usr/bin/node', ['--import', 'tsx']],
      ['/usr/bin/node', '--import', 'tsx', '/repo/strands-cli/src/main.ts'],
    ],
    // An installed strands is a link without an extension, and the runtime still needs it.
    [
      ['/opt/homebrew/bin/strands', '/usr/bin/node', []],
      ['/usr/bin/node', '/opt/homebrew/bin/strands'],
    ],
    [['/usr/local/bin/strands', '/usr/local/bin/strands', []], ['/usr/local/bin/strands']],
    [[undefined, '/usr/local/bin/strands', []], ['/usr/local/bin/strands']],
  ] as const)('shouldStartTheSameStrandsThatIsRunning %j', ([entry, runtime, flags], command) => {
    expect(strandsCommandOf(entry, runtime, flags)).toEqual(command)
  })

  it('shouldGiveTheRequestOnStandardInputAndWriteAllItPrintsToTheLog', async () => {
    const { root, workspace, log, worker } = await workerSetup()

    const exit = await worker({ workspace, prompt: 'exit 0', log, signal: new AbortController().signal })

    const printed = await readFile(log, 'utf8')
    expect(exit).toEqual({ code: 0 })
    expect(printed).toContain('request: exit 0')
    expect(printed).toContain(`arguments: ${JSON.stringify(autoOptimizeWorkerArguments(workspace))}`)
    expect(printed).toContain(`cwd: ${await realpath(root)}`)
    // The strands dev that starts it has the project open, so the agent must not install or build it again.
    expect(printed).toContain('prepared: 1')
  })

  it('shouldGiveTheExitCodeOfAnAgentThatFailed', async () => {
    const { workspace, log, worker } = await workerSetup()

    const exit = await worker({ workspace, prompt: 'exit 3', log, signal: new AbortController().signal })

    expect(exit).toEqual({ code: 3 })
  })

  it('shouldStopTheAgentWhenTheSignalAborts', async () => {
    const { root, workspace, log, worker } = await workerSetup()
    const started = join(root, 'started')
    const stop = new AbortController()

    const exit = worker({ workspace, prompt: `wait ${started}`, log, signal: stop.signal })
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 })
    stop.abort()

    expect((await exit).code).not.toBe(0)
  })

  it('shouldNotLeaveItsListenersBehindWhenTheAgentEnds', async () => {
    const { workspace, log, worker } = await workerSetup()
    const before = process.listenerCount('exit')

    await worker({ workspace, prompt: 'exit 0', log, signal: new AbortController().signal })

    expect(process.listenerCount('exit')).toBe(before)
  })
})
