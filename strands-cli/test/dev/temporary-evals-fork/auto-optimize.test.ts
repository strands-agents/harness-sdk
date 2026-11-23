import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  autoOptimizeRequest,
  isAutoOptimizeRequest,
  TemporaryAutoOptimize,
} from '../../../src/dev/temporary-evals-fork/auto-optimize.js'
import type { TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import type { DevChatCommandContext } from '../../../src/ui/chat/types.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const workspaceIn = (root: string): DevWorkspace => ({
  directory: join(root, 'strands-dev'),
  root,
  entrypoint: join(root, 'agent.ts'),
  config: { version: 1, name: 'desk', language: 'typescript', entrypoint: 'agent.ts', origin: { kind: 'discovered' } },
})

/** A workspace whose auto-optimize setting and whose running optimization the test can change as turns go by. */
const counting = async (every = 5, root?: string) => {
  const workspace = workspaceIn(root ?? (await temporaryDirectory()))
  const state = { every, busy: false }
  const host = (): TemporarySessionHost => ({
    workspace,
    agent: () => ({}),
    settings: () => ({ autoAcceptOptimizationResults: false, autoOptimize: state.every }),
  })
  const auto = new TemporaryAutoOptimize(host, { busy: () => state.busy })
  const submit = vi.fn()
  const context: DevChatCommandContext = {
    signal: new AbortController().signal,
    report: () => ({ update: vi.fn() }),
    fail: vi.fn(),
    submit,
    openPanel: vi.fn(() => true),
  }
  const turns = async (...prompts: string[]): Promise<void> => {
    for (const prompt of prompts) await auto.turnEnded(context, { prompt })
  }
  const file = join(workspace.directory!, 'tmp', '.state', 'auto-optimize.json')
  // In a workspace that has counted nothing yet, the cadence was set in a turn, and that turn is not counted.
  if (every > 0 && root === undefined) await turns(`optimize every ${every} turns from my history`)
  return { auto, state, submit, turns, file, root: workspace.root }
}

const FIVE = ['one', 'two', 'three', 'four', 'five']

describe('auto-optimize every N turns', () => {
  it('shouldSendItsRequestWhenThatManyChatTurnsHavePassedAndStartCountingAgain', async () => {
    const { auto, submit, turns } = await counting(5)

    await turns('one', 'two', 'three', 'four')
    const before = [submit.mock.calls.length, await auto.status()]
    await turns('five')

    expect(before).toEqual([0, { everyTurns: 5, turnsSince: 4 }])
    expect(submit.mock.calls).toEqual([['/optimize auto-optimize: 5 chat turns since the last one']])
    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 0 })
    await turns(...FIVE)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('shouldCountWhatTheDeveloperSaidToTheAgentAndNotTheCommands', async () => {
    const { auto, submit, turns } = await counting(5)

    await turns(
      'one',
      '/optimize refunds',
      '!ls',
      '$review this',
      '/optimize auto-optimize: 5 chat turns since the last one'
    )

    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 1 })
    expect(submit).not.toHaveBeenCalled()
  })

  it('shouldCountNothingAndWriteNothingWhileItIsOff', async () => {
    const { auto, submit, turns, file } = await counting(0)

    await turns(...FIVE, ...FIVE)

    expect(submit).not.toHaveBeenCalled()
    expect(await auto.status()).toEqual({ everyTurns: 0, turnsSince: 0 })
    expect(existsSync(file)).toBe(false)
  })

  it('shouldNotCountTheTurnThatSetTheCadence', async () => {
    const { auto, state, submit, turns, file } = await counting(0)

    state.every = 5
    await turns('optimize every 5 turns from my history')
    const afterTheTurnThatSetIt = await auto.status()
    await turns('one', 'two', 'three', 'four')
    const beforeTheFifth = submit.mock.calls.length
    await turns('five')

    // The agent tells the developer that the first run comes 5 turns from now, so the turn that set it is not one.
    expect(afterTheTurnThatSetIt).toEqual({ everyTurns: 5, turnsSince: 0 })
    expect(beforeTheFifth).toBe(0)
    expect(submit).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ turns: 0, every: 5 })
  })

  it('shouldStartFromNoTurnsWhenItIsTurnedOnAgain', async () => {
    const { auto, state, submit, turns } = await counting(5)
    await turns('one', 'two', 'three')

    state.every = 0
    await turns('turn it off')
    state.every = 5
    await turns('turn it on again', 'five', 'six')

    expect(await auto.status()).toEqual({ everyTurns: 5, turnsSince: 2 })
    expect(submit).not.toHaveBeenCalled()
  })

  it('shouldCarryTheCountOverWhenStrandsDevOpensAgain', async () => {
    const first = await counting(5)
    await first.turns('one', 'two', 'three')
    expect(JSON.parse(await readFile(first.file, 'utf8'))).toEqual({ turns: 3, every: 5 })

    const again = await counting(5, first.root)
    await again.turns('four', 'five')

    expect(again.submit).toHaveBeenCalledOnce()
    expect(first.submit).not.toHaveBeenCalled()
  })

  it('shouldWaitWhileAnOptimizationRunsOrItsEditsWaitAndThenSendTheRequest', async () => {
    const { auto, state, submit, turns } = await counting(5)
    state.busy = true

    await turns(...FIVE, 'six')
    const whileBusy = [submit.mock.calls.length, (await auto.status()).turnsSince]
    state.busy = false
    // The run is due already, so the end of any turn sends it, also one that is not counted.
    await turns('/experiment refunds')

    expect(whileBusy).toEqual([0, 6])
    expect(submit).toHaveBeenCalledExactlyOnceWith('/optimize auto-optimize: 5 chat turns since the last one')
    expect((await auto.status()).turnsSince).toBe(0)
  })

  it('shouldStartTheCountAgainWhenTheCadenceChangesAndStartNoRunWithTheTurnsOfTheOldOne', async () => {
    const { auto, state, submit, turns } = await counting(20)
    await turns(...FIVE, 'six')

    state.every = 5
    // Six turns are more than the new five, but they were counted towards a run every twenty.
    const reported = await auto.status()
    await turns('make it every 5')
    const afterTheChange = [submit.mock.calls.length, await auto.status()]
    await turns(...FIVE)

    expect(reported).toEqual({ everyTurns: 5, turnsSince: 0 })
    expect(afterTheChange).toEqual([0, { everyTurns: 5, turnsSince: 0 }])
    expect(submit).toHaveBeenCalledExactlyOnceWith('/optimize auto-optimize: 5 chat turns since the last one')
  })

  it('shouldStartTheCountAgainWhenTheSavedCountNamesNoCadence', async () => {
    const first = await counting(5)
    await first.turns('one', 'two', 'three')
    await writeFile(first.file, '{"turns":4}\n')

    const again = await counting(5, first.root)
    await again.turns('four')

    expect(again.submit).not.toHaveBeenCalled()
    expect(await again.auto.status()).toEqual({ everyTurns: 5, turnsSince: 0 })
  })

  it('shouldNotSendTwoRequestsWhenTwoTurnsEndTogether', async () => {
    const { auto, submit, turns } = await counting(5)
    await turns('one', 'two', 'three', 'four')
    const context = { submit } as unknown as DevChatCommandContext

    await Promise.all([auto.turnEnded(context, { prompt: 'five' }), auto.turnEnded(context, { prompt: 'six' })])

    expect(submit).toHaveBeenCalledOnce()
    expect((await auto.status()).turnsSince).toBe(1)
  })

  it.each([
    ['auto-optimize: 20 chat turns since the last one', true],
    ['  Auto-Optimize', true],
    ['refunds, instructions only', false],
    ['', false],
  ])('shouldTellItsOwnRequestFromOneThatAsksForARun %j', (request, own) => {
    expect(isAutoOptimizeRequest(request)).toBe(own)
  })

  it('shouldSendARequestThatOptimizeTakesAsItsOwn', () => {
    const [command, ...request] = autoOptimizeRequest(20).split(' ')

    expect(command).toBe('/optimize')
    expect(isAutoOptimizeRequest(request.join(' '))).toBe(true)
  })
})
