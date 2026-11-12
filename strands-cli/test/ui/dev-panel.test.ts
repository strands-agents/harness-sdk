import { createElement, useState, type ReactElement } from 'react'
import { Text, useInput, type Instance } from 'ink'
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

const mount = async (command: DevChatCommand | readonly DevChatCommand[], rows = 40) => {
  const controller = new ChatController(idleBackend(), {
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

const experimentWithJobs = (): { command: DevChatCommand; jobs: ReturnType<typeof jobFeed> } => {
  const { command } = probe()
  const jobs = jobFeed()
  return {
    command: { ...command, spec: { name: 'experiment', usage: '/experiment', description: 'Experiments' }, jobs },
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

    await press('x')
    await press('y')

    expect(screen()).toContain('probe panel keys:[xy]')
    await press('\u001b')
    await vi.waitFor(() => expect(controller.getSnapshot().panel).toBeUndefined())
    await vi.waitFor(() => expect(screen()).not.toContain('probe panel'))
    expect(screen()).not.toContain('xy')
  })
})

describe('dev jobs row', () => {
  it('shouldShowRunningJobsBelowThePromptWhenADevCommandReportsThem', async () => {
    const { command, jobs } = experimentWithJobs()
    const { instance, row } = await mount(command)

    jobs.set([
      { id: 'a', label: 'refunds', done: 3, total: 20 },
      { id: 'b', label: 'edge-cases', done: 0, total: 10 },
    ])
    await instance.waitUntilRenderFlush()

    expect(row('/experiment refunds 3/20 · edge-cases 0/10')).toBeGreaterThan(row('Enter to send'))
    expect(row('click to open')).toBe(row('/experiment refunds 3/20'))
  })

  it('shouldHideTheRowWhenNoJobRuns', async () => {
    const { command, jobs } = experimentWithJobs()
    const { instance, screen } = await mount(command)
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    await instance.waitUntilRenderFlush()

    jobs.set([])
    await instance.waitUntilRenderFlush()

    expect(screen()).not.toContain('click to open')
  })

  it.each([
    ['no panel', undefined],
    ['another panel', '/help'],
  ])('shouldOpenTheCommandPanelWhenTheUserClicksItsJobOver%s', async (_case, before) => {
    const { command, jobs } = experimentWithJobs()
    const { controller, instance, click, screen } = await mount(command)
    jobs.set([{ id: 'a', label: 'refunds', done: 3, total: 20 }])
    if (before) await controller.submit(before)
    await instance.waitUntilRenderFlush()

    await click('/experiment refunds')

    await vi.waitFor(() => expect(controller.getSnapshot().panel).toMatchObject({ kind: 'dev', title: '/experiment' }))
    await vi.waitFor(() => expect(screen()).toContain('probe panel'))
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
    expect(screen()).toContain('click to open')
  })
})
