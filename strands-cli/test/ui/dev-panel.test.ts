import { createElement, useState, type ReactElement } from 'react'
import { Box, Text, useInput, type Instance } from 'ink'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type ChatControllerApi,
  type DevChatCommand,
  type DevChatJob,
  type DevChatJobs,
  type DevChatPanelProps,
} from '../../src/ui/chat/controller.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { useDevPanelClicks } from '../../src/ui/panels/dev.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const mounted: { instance: Instance; controller: ChatControllerApi }[] = []

afterEach(async () => {
  for (const { instance, controller } of mounted.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
})

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
  const controller = new ChatController(backend, {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [command].flat(),
  })
  const input = ttyInput()
  const output = ttyOutput(120, rows)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
  })
  const instance = render(createElement(ChatApp, { controller }), {
    stdin: input,
    stdout: output,
    stderr: output,
    interactive: true,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  mounted.push({ instance, controller })
  await instance.waitUntilRenderFlush()
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  const row = (text: string): number => frame.split('\n').findIndex((line) => line.includes(text))
  const click = async (text: string): Promise<void> => {
    const lines = frame.split('\n')
    const line = row(text)
    expect(line, `Visible target: ${text}`).toBeGreaterThanOrEqual(0)
    const column = stringWidth(lines[line]!.slice(0, lines[line]!.indexOf(text))) + 1
    await press(`\u001b[<0;${column};${line + 1}M`)
    await press(`\u001b[<0;${column};${line + 1}m`)
  }
  return { controller, instance, press, click, screen: (): string => frame, row }
}

const jobFeed = (): DevChatJobs & { set: (jobs: readonly DevChatJob[]) => void } => {
  let jobs: readonly DevChatJob[] = []
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => jobs,
    set: (next) => {
      jobs = next
      for (const listener of listeners) listener()
    },
  }
}

const experimentWithJobs = () => {
  const { command } = probe()
  const jobs = jobFeed()
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

const reviewerTask = () =>
  idleBackend({
    watchTasks(listener) {
      listener([{ id: 'review', label: 'Reviewer', status: 'working', source: 'background' }])
      return () => {}
    },
  })

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

    await press('x')
    await press('y')

    expect(screen()).toContain('probe panel keys:[xy]')
    await press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await vi.waitFor(() => expect(screen()).not.toContain('probe panel'))
    expect(screen()).not.toContain('xy')
  })
})

describe('dev panel clicks', () => {
  it('shouldRunTheClickTargetAndKeepThePanelOpenWhenTheUserClicksInsideADevPanel', async () => {
    const clicked = vi.fn()
    const ClickPanel = (): ReactElement => {
      const clicks = useDevPanelClicks()
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, null, 'panel heading'),
        createElement(Box, clicks ? { ref: clicks.target(clicked) } : {}, createElement(Text, null, 'clickable row'))
      )
    }
    const command: DevChatCommand = {
      spec: { name: 'probe', usage: '/probe', description: 'Probe' },
      open: () => ClickPanel,
    }
    const { controller, instance, click } = await mount(command)
    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()

    await click('panel heading')
    await click('clickable row')

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/probe' })
  })
})

describe('dev panel hover', () => {
  it('shouldRunTheHoverTargetAndNotTheClickWhenThePointerMovesOverADevPanelTarget', async () => {
    const clicked = vi.fn()
    const hovered = vi.fn()
    const HoverPanel = (): ReactElement => {
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
    const command: DevChatCommand = {
      spec: { name: 'probe', usage: '/probe', description: 'Probe' },
      open: () => HoverPanel,
    }
    const { controller, instance, press, row, screen } = await mount(command)
    await controller.submit('/probe')
    await instance.waitUntilRenderFlush()
    const line = row('pointer row')
    const column =
      stringWidth(screen().split('\n')[line]!.slice(0, screen().split('\n')[line]!.indexOf('pointer row'))) + 1

    await press(`\u001b[<35;${column};${line + 1}M`)

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
    const { controller, press, row } = await mount(command, 40, reviewerTask())
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
