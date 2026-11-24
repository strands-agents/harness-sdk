import { createElement, useState, type ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import { type DevChatCommand, type DevChatJob, type DevChatPanelProps } from '../../src/ui/chat/controller.js'
import { useDevPanelClicks } from '../../src/ui/panels/dev.js'
import { jobStore, mountChat } from '../fixtures/chat-app.js'
import { idleBackend } from '../fixtures/chat-backend.js'

const probe = (): { command: DevChatCommand; sizes: { width: number; height: number }[] } => {
  const sizes: { width: number; height: number }[] = []
  const ProbePanel = ({ width, height, close }: DevChatPanelProps): ReactElement => {
    const [keys, setKeys] = useState('')
    sizes.push({ width, height })
    useInput((input, key) => {
      if (key.escape) close()
      else setKeys((current) => current + input)
    })
    return createElement(Text, null, `probe panel keys:[${keys}]`)
  }
  return {
    command: { spec: { name: 'probe', usage: '/probe', description: 'Probe' }, open: () => ProbePanel },
    sizes,
  }
}

const mount = async (command: DevChatCommand | readonly DevChatCommand[], rows = 40, backend = idleBackend()) => {
  const view = await mountChat({ devCommands: [command].flat(), rows, backend })
  const at = (text: string): string => {
    const line = view.row(text)
    expect(line, `Visible target: ${text}`).toBeGreaterThanOrEqual(0)
    return `${stringWidth(view.lines()[line]!.slice(0, view.lines()[line]!.indexOf(text))) + 1};${line + 1}`
  }
  const click = async (text: string): Promise<void> => {
    await view.press(`\u001b[<0;${at(text)}M`, `\u001b[<0;${at(text)}m`)
  }
  return { ...view, at, click }
}

const experimentWithJobs = () => {
  const { command } = probe()
  const jobs = jobStore()
  const open = vi.fn(command.open)
  return {
    command: {
      ...command,
      spec: { name: 'experiment', usage: '/experiment', description: 'Experiments' },
      open,
      jobs,
    } satisfies DevChatCommand,
    jobs,
    open,
  }
}

const TWO_JOBS: readonly DevChatJob[] = [
  { id: 'a', label: 'refunds', done: 3, total: 20 },
  { id: 'b', label: 'edge-cases', done: 0, total: 10 },
]

const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'

const OPTIMIZE_TOOL = 'strands_dev_optimize'

const backgroundTasks = (...labels: string[]) =>
  idleBackend({
    watchTasks(listener) {
      listener(labels.map((label) => ({ id: label, label, status: 'working', source: 'background' })))
      return () => {}
    },
  })

const optimizeWithJobs = () => {
  const { command, jobs } = experimentWithJobs()
  return {
    command: {
      ...command,
      spec: { name: 'optimize', usage: '/optimize', description: 'Optimize' },
      backgroundTools: [OPTIMIZE_TOOL],
    } satisfies DevChatCommand,
    jobs,
  }
}

describe('dev command panels', () => {
  it('shouldDrawTheDevPanelAboveThePromptWhenADevCommandOpens', async () => {
    const { command } = probe()
    const { controller, instance, row } = await mount(command)

    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()

    expect(row('probe panel')).toBeGreaterThanOrEqual(0)
    expect(row('probe panel')).toBeLessThan(row('Viewing /probe'))
  })

  it.each([
    [40, 18],
    [24, 10],
  ])('shouldGiveTheDevPanelAboutHalfOfA%iRowScreenWhenItOpens', async (rows, height) => {
    const { command, sizes } = probe()
    const { controller, instance } = await mount(command, rows)

    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()

    expect(sizes.at(-1)?.height).toBe(height)
  })

  it('shouldSendKeysToTheDevPanelAndNotToThePromptWhenItIsOpen', async () => {
    const { command } = probe()
    const { controller, instance, press, screen } = await mount(command)
    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()

    await press('x', 'y')

    expect(screen()).toContain('probe panel keys:[xy]')
    await press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await vi.waitFor(() => expect(screen()).not.toContain('probe panel'))
    expect(screen()).not.toContain('xy')
  })
})

describe('dev panel pointer targets', () => {
  const openPointerPanel = async (clicked: () => void, hovered?: () => void) => {
    const PointerPanel = (): ReactElement => {
      const clicks = useDevPanelClicks()
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, null, 'panel heading'),
        createElement(
          Box,
          clicks ? { ref: clicks.target(clicked, hovered) } : {},
          createElement(Text, null, 'pointer row')
        )
      )
    }
    const view = await mount({ ...probe().command, open: () => PointerPanel })
    await view.controller.submit('/probe')
    await view.instance.waitUntilRenderFlush()
    return view
  }

  it('shouldRunTheClickTargetAndKeepThePanelOpenWhenTheUserClicksInsideADevPanel', async () => {
    const clicked = vi.fn()
    const { controller, click } = await openPointerPanel(clicked)

    await click('panel heading')
    await click('pointer row')

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/probe' })
  })

  it('shouldRunTheHoverTargetAndNotTheClickWhenThePointerMovesOverADevPanelTarget', async () => {
    const clicked = vi.fn()
    const hovered = vi.fn()
    const { at, press } = await openPointerPanel(clicked, hovered)

    await press(`\u001b[<35;${at('pointer row')}M`)

    expect(hovered).toHaveBeenCalled()
    expect(clicked).not.toHaveBeenCalled()
  })
})

describe('dev jobs row', () => {
  it('shouldStackTheRunningJobsInOneRowBelowThePromptWhenADevCommandReportsThem', async () => {
    const { command, jobs } = experimentWithJobs()
    const { instance, row, screen } = await mount(command)

    jobs.set(TWO_JOBS)
    await instance.waitUntilRenderFlush()

    expect(row('/experiment 1/2 · ● refunds 3/20')).toBeGreaterThan(row('Enter to send'))
    expect(row('↓ view')).toBe(row('/experiment 1/2'))
    expect(screen()).not.toContain('edge-cases')
  })

  it('shouldHideTheRowWhenNoJobRuns', async () => {
    const { command, jobs } = experimentWithJobs()
    const { instance, screen } = await mount(command)
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    await instance.waitUntilRenderFlush()

    jobs.set([])
    await instance.waitUntilRenderFlush()

    expect(screen()).not.toContain('refunds 3/20')
  })

  it.each([
    ['no panel', undefined],
    ['another panel', '/help'],
  ])('shouldOpenTheShownJobWhenTheUserClicksTheRowOver%s', async (_case, before) => {
    const { command, jobs, open } = experimentWithJobs()
    const { controller, instance, click, screen } = await mount(command)
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    if (before) await controller.submit(before)
    await instance.waitUntilRenderFlush()

    await click('refunds 3/20')

    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/experiment' }))
    await vi.waitFor(() => expect(screen()).toContain('probe panel'))
    expect(open).toHaveBeenLastCalledWith(expect.anything(), { job: 'a' })
  })

  it.each([
    ['ShowsItItself', true, undefined],
    ['LeavesItToThePanel', false, { kind: 'dev', title: '/experiment' }],
  ])('shouldAskTheCommandFirstWhenAJobIsOpenedAndItThen%s', async (_case, shown, panel) => {
    const { command, jobs, open } = experimentWithJobs()
    const openJob = vi.fn(() => shown)
    const { controller, instance, click } = await mount({ ...command, openJob })
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    await instance.waitUntilRenderFlush()

    await click('refunds 3/20')

    await vi.waitFor(() => expect(openJob).toHaveBeenCalledWith(expect.anything(), 'a'))
    await vi.waitFor(() =>
      panel
        ? expect(controller.getSnapshot().panel).toMatchObject(panel)
        : expect(controller.getSnapshot().panel).toBeUndefined()
    )
    expect(open).toHaveBeenCalledTimes(shown ? 0 : 1)
  })

  it('shouldOpenTheChosenJobWhenTheUserPressesDownThenRightThenEnter', async () => {
    const { command, jobs, open } = experimentWithJobs()
    const { controller, instance, press, row } = await mount(command)
    jobs.set(TWO_JOBS)
    await instance.waitUntilRenderFlush()

    await press(DOWN)
    expect(row('←→ Enter Esc')).toBe(row('/experiment 1/2 · ● refunds 3/20'))
    await press(RIGHT)
    expect(row('←→ Enter Esc')).toBe(row('/experiment 2/2 · ● edge-cases 0/10'))
    await press('\r')

    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/experiment' }))
    expect(open).toHaveBeenLastCalledWith(expect.anything(), { job: 'b' })
  })

  it('shouldGiveTheKeysBackToThePromptWhenTheUserPressesEscapeOnTheRow', async () => {
    const { command, jobs, open } = experimentWithJobs()
    const { controller, instance, press, row } = await mount(command)
    jobs.set(TWO_JOBS)
    await instance.waitUntilRenderFlush()

    await press(DOWN)
    expect(row('←→ Enter Esc')).toBe(row('/experiment 1/2 · ● refunds 3/20'))
    await press('\u001b')

    await vi.waitFor(() => expect(row('↓ view')).toBe(row('/experiment 1/2 · ● refunds 3/20')))
    expect(row('/experiment 1/2')).toBeGreaterThan(0)
    expect(controller.getSnapshot().panel).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })

  it('shouldMoveFromTheBackgroundTaskToTheJobWhenTheUserPressesRight', async () => {
    const { command, jobs, open } = experimentWithJobs()
    const { controller, press, row } = await mount(command, 40, backgroundTasks('Reviewer'))
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    await vi.waitFor(() => expect(row('Background · ● Reviewer')).toBeGreaterThan(0))

    await press(DOWN)
    expect(row('←→ Enter Esc')).toBe(row('Background · ● Reviewer'))
    await press(RIGHT)
    expect(row('←→ Enter Esc')).toBe(row('/experiment · ● refunds 3/20'))
    await press('\r')

    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/experiment' }))
    expect(open).toHaveBeenLastCalledWith(expect.anything(), { job: 'a' })
  })

  it('shouldNotListTheBackgroundRunOfAToolWhoseCommandShowsItsProgress', async () => {
    const { command, jobs } = optimizeWithJobs()
    const { row, screen } = await mount(command, 40, backgroundTasks(OPTIMIZE_TOOL))
    await vi.waitFor(() => expect(row(`Background · ● ${OPTIMIZE_TOOL}`)).toBeGreaterThan(0))

    jobs.set([{ id: 'run-1', label: '20261122-234850-combined-all', done: 1, total: 17 }])

    await vi.waitFor(() => expect(row('/optimize · ● 20261122-234850-combined-all 1/17')).toBeGreaterThan(0))
    expect(screen()).not.toContain('Background ·')
    expect(screen()).not.toContain(OPTIMIZE_TOOL)
  })

  it('shouldKeepListingOtherBackgroundWorkBesideTheProgressOfACommand', async () => {
    const { command, jobs } = optimizeWithJobs()
    const { row, screen } = await mount(command, 40, backgroundTasks(OPTIMIZE_TOOL, 'Reviewer'))

    jobs.set([{ id: 'run-1', label: 'combined-all', done: 1, total: 17 }])

    await vi.waitFor(() => expect(row('/optimize · ● combined-all 1/17')).toBeGreaterThan(0))
    expect(row('Background · ● Reviewer')).toBeGreaterThan(0)
    expect(screen()).not.toContain(OPTIMIZE_TOOL)
    expect(screen()).not.toContain('Background 1/2')
  })

  it('shouldListTheBackgroundRunOfAToolWhileItsCommandOnlyHasAJobThatWaitsOnTheDeveloper', async () => {
    const { command, jobs } = optimizeWithJobs()
    const { row } = await mount(command, 40, backgroundTasks(OPTIMIZE_TOOL))

    jobs.set([{ id: 'run-0', label: 'earlier-run · 1 to review', waiting: true }])

    await vi.waitFor(() => expect(row('/optimize · ● earlier-run · 1 to review')).toBeGreaterThan(0))
    expect(row(`Background · ● ${OPTIMIZE_TOOL}`)).toBeGreaterThan(0)
  })

  it('shouldOpenTheJobAndNotAHiddenBackgroundTaskWhenTheUserPressesDownThenEnter', async () => {
    const { command, jobs } = optimizeWithJobs()
    const open = vi.fn(command.open)
    const { controller, press, row } = await mount({ ...command, open }, 40, backgroundTasks(OPTIMIZE_TOOL))
    jobs.set([{ id: 'run-1', label: 'combined-all', done: 1, total: 17 }])
    await vi.waitFor(() => expect(row('/optimize · ● combined-all 1/17')).toBeGreaterThan(0))

    await press(DOWN)
    expect(row('←→ Enter Esc')).toBe(row('/optimize · ● combined-all 1/17'))
    await press('\r')

    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/optimize' }))
    expect(open).toHaveBeenLastCalledWith(expect.anything(), { job: 'run-1' })
  })

  it.each([40, 24])('shouldFitTheScreenWithTheRowAndAnOpenPanelAt%iRows', async (rows) => {
    const { command, jobs } = experimentWithJobs()
    const { controller, instance, screen } = await mount(command, rows)
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    await controller.submit('/experiment')
    await instance.waitUntilRenderFlush()

    const lines = screen().trimEnd().split('\n')

    expect(lines.length).toBeLessThanOrEqual(rows)
    expect(screen()).toContain('probe panel')
    expect(screen()).toContain('/experiment · ● refunds 3/20')
  })
})

describe('a dev panel that asks for the dock', () => {
  const widthAt = async (columns: number, dock: boolean): Promise<number> => {
    const { command, sizes } = probe()
    const { controller, instance } = await mountChat({
      devCommands: [{ ...command, sticky: true, ...(dock ? { dock: (): boolean => true } : {}) }],
      columns,
    })
    controller.openDevCommand('probe')
    await instance.waitUntilRenderFlush()
    return sizes.at(-1)!.width
  }

  it('shouldRenderNarrowerThanTheTerminalSoTheTranscriptKeepsTheRest', async () => {
    const width = await widthAt(120, true)

    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThan(120 / 2)
  })

  it('shouldTakeTheFullWidthWhenItDoesNotAskForTheDock', async () => {
    expect(await widthAt(120, false)).toBeGreaterThan(120 / 2)
  })

  it('shouldFallBackToTheInlinePanelOnANarrowTerminal', async () => {
    expect(await widthAt(70, true)).toBeGreaterThan(70 / 2)
  })
})

describe('startup logo with a dev panel', () => {
  const ARTWORK = /[█▀▄▟▙]/u
  const artwork = (lines: readonly string[]): readonly string[] => lines.filter((line) => ARTWORK.test(line))

  it.each([40, 30, 24, 20])('shouldKeepTheLogoAtItsSizeWhenADevPanelOpensIn %i rows', async (rows) => {
    const { controller, instance, lines, screen } = await mount(probe().command, rows)
    const before = artwork(lines())

    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()

    expect(screen()).toContain('probe panel')
    expect(before.length).toBeGreaterThan(1)
    expect(artwork(lines())).toEqual(before)
  })

  it('shouldGiveTheRowsOfTheLogoPaddingToThePanelWhenTheScreenIsShort', async () => {
    const { controller, instance, lines } = await mount(probe().command)
    const logoTop = (): number => lines().findIndex((line) => ARTWORK.test(line))
    const before = logoTop()

    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()

    expect(before).toBeGreaterThan(logoTop())
    expect(logoTop()).toBeGreaterThanOrEqual(0)
  })
})

const askCommand = (dropPending?: () => boolean): DevChatCommand => {
  const Panel = ({ close, active = true, blur }: DevChatPanelProps): ReactElement => {
    const [keys, setKeys] = useState('')
    useInput(
      (input, key) => {
        if (key.escape) close()
        else if (key.downArrow) blur?.()
        else setKeys((current) => current + input)
      },
      { isActive: active }
    )
    return createElement(Text, null, `question keys:[${keys}]`)
  }
  return {
    spec: { name: 'ask', usage: '/ask', description: 'Ask' },
    sticky: true,
    ...(dropPending ? { dropPending } : {}),
    open: () => Panel,
  }
}

describe('a sticky question panel', () => {
  const openAsk = async (command = askCommand()) => {
    const view = await mount(command)
    await view.press('/ask', '\r')
    return view
  }

  it('shouldTypeIntoTheChatInputAfterLeavingWhileTheQuestionStaysOnScreen', async () => {
    const { controller, press, screen } = await openAsk()
    expect(screen()).toContain('question keys:[]')

    await press('\u001b[B', 'h', 'i')

    expect(screen()).toContain('question keys:[]')
    expect(screen()).toContain('hi')
    expect(controller.getSnapshot().panel?.kind).toBe('dev')
  })

  it('shouldSubmitToTheAgentWhileTheQuestionStaysOnScreen', async () => {
    const { controller, press, screen } = await openAsk()
    await press('\u001b[B')

    await press('h', 'e', 'y', '\r')

    expect(screen()).toContain('question keys:[]')
    expect(controller.getSnapshot().panel?.kind).toBe('dev')
    expect(screen()).toContain('hey')
  })

  it('shouldLeaveTheQuestionOpenWhenTheDeveloperClicksTheInput', async () => {
    const { controller, press } = await openAsk()

    await press('\u001b[<0;10;37M', '\u001b[<0;10;37m')

    expect(controller.getSnapshot().panel?.kind).toBe('dev')
  })

  it('shouldMoveBetweenTheQuestionAndTheChatWithTheArrows', async () => {
    const { press, screen } = await openAsk()

    await press('\u001b[B', 'h')
    expect(screen()).toContain('question keys:[]')
    expect(screen()).toContain('h')

    await press('\u007f', '\u001b[A', 'z')

    expect(screen()).toContain('question keys:[z]')
  })

  it('shouldComeBackToTheInputFromTheStatusLineBeforeUpMovesIntoTheQuestion', async () => {
    const jobs = { subscribe: () => () => {}, snapshot: () => [{ id: 'a', label: 'refunds', done: 1, total: 1 }] }
    const { press, screen } = await openAsk({ ...askCommand(), jobs })
    await press('\u001b[B')
    expect(screen()).toContain('Enter view')

    await press('\u001b[A', 'z')

    expect(screen()).not.toContain('Enter view')
    expect(screen()).toContain('question keys:[]')

    await press('\u007f', '\u001b[A', 'z')

    expect(screen()).toContain('question keys:[z]')
  })

  it('shouldDropThePendingQuestionAndSteerTheMessageIntoTheTurn', async () => {
    const dropped: number[] = []
    const { controller, press } = await openAsk(askCommand(() => dropped.push(1) > 0))
    const steer = vi.spyOn(controller, 'steer')
    await press('\u001b[B')

    await press('h', 'i', '\r')

    expect(dropped).toEqual([1])
    expect(steer).toHaveBeenCalledWith('hi')
  })

  it('shouldSendTheMessageAsAnyOtherWhenThePanelKeepsItsQuestion', async () => {
    const { controller, press, screen } = await openAsk(askCommand(() => false))
    const steer = vi.spyOn(controller, 'steer')
    const submit = vi.spyOn(controller, 'submit')
    await press('\u001b[B')

    await press('h', 'i', '\r')

    expect(steer).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledWith('hi')
    expect(controller.getSnapshot().panel?.kind).toBe('dev')
    expect(screen()).toContain('question keys:[]')
  })

  it.each([
    ['TheDeveloperRunsACommand', ['/settings', '\r']],
    ['TheInputIsEmpty', ['\r']],
  ])('shouldKeepThePendingQuestionWhen%s', async (_case, keys) => {
    const dropped: number[] = []
    const { press } = await openAsk(askCommand(() => dropped.push(1) > 0))
    await press('\u001b[B')

    for (const key of keys) await press(key)

    expect(dropped).toEqual([])
  })

  it('shouldNotTakeTheKeyboardBackWhileTheDeveloperDragsToSelectText', async () => {
    const { press, screen } = await openAsk()
    await press('\u001b[B')
    const row = screen()
      .split('\n')
      .findIndex((line) => line.includes('question keys:'))
    expect(row).toBeGreaterThanOrEqual(0)
    const composer = (): string =>
      screen()
        .split('\n')
        .filter((line) => line.includes('Viewing /ask') || line.includes('Enter drops the question'))
        .join()
    const before = composer()

    await press(`\u001b[<0;6;${row + 1}M`, `\u001b[<32;12;${row + 1}M`, `\u001b[<32;20;${row + 1}M`)

    expect(composer()).toBe(before)
  })

  it('shouldSayEnterSendsOnBothSidesOfAQuestion', async () => {
    const { press, screen } = await openAsk()

    expect(screen()).toContain('Enter to send')
    expect(screen()).not.toContain('Viewing /ask')

    await press('\u001b[A')

    expect(screen()).toContain('Enter to send')
    expect(screen()).not.toContain('Viewing /ask')
  })

  it('shouldTakeTheKeyboardForAPanelThatIsNotSticky', async () => {
    const { press, screen } = await openAsk({ ...askCommand(), sticky: false })

    await press('x')

    expect(screen()).toContain('question keys:[x]')
  })

  it('shouldSendKeysToTheChatUntilUpMovesIntoTheQuestion', async () => {
    const { press, screen } = await openAsk()

    await press('x')
    expect(screen()).toContain('question keys:[]')

    await press('\u007f', '\u001b[A', 'x')

    expect(screen()).toContain('question keys:[x]')
  })

  it('shouldKeepTheInputWhenUpArrivesWithTextTyped', async () => {
    const { press, screen } = await openAsk()
    await press('\u001b[B', 'a')

    await press('\u001b[A', 'z')

    expect(screen()).toContain('question keys:[]')
  })
})
