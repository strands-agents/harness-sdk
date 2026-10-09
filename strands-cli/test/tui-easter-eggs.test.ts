import { createElement } from 'react'
import { render, renderToString } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

import { commandAssistance } from '../src/tui/chat/commands.js'
import { ChatController, type ChatBackend } from '../src/tui/chat/controller.js'
import { externalUrlCommand } from '../src/tui/terminal/open-url.js'
import { ChatApp } from '../src/tui/view/app.js'
import { ChatView } from '../src/tui/view/chat-view.js'
import { FROG_ANIMATION_HEIGHT, parseFrogCommand } from '../src/tui/view/frog-easter-egg.js'
import { renderFrogAnimationRuns, type FrogAnimationRun } from '../src/tui/view/frog-intro-renderer.js'

const instances: { unmount(): void }[] = []

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.unmount()
  }
})

describe('/frog', () => {
  it('supports named and cycling animations without appearing in command suggestions', () => {
    expect(parseFrogCommand('/frog hop')).toBe('hop')
    expect(parseFrogCommand('/FROG fly')).toBe('fly')
    expect(parseFrogCommand('/frog peek')).toBe('peek')
    expect(parseFrogCommand('/frog firefly')).toBe('firefly')
    expect(parseFrogCommand('/frog')).toBe('hop')
    expect(parseFrogCommand('/frog', 'hop')).toBe('fly')
    expect(parseFrogCommand('/frog', 'fly')).toBe('peek')
    expect(parseFrogCommand('/frog', 'peek')).toBe('firefly')
    expect(parseFrogCommand('/frog', 'firefly')).toBe('hop')
    expect(parseFrogCommand('/frog hop', 'hop')).toBe('hop')
    expect(parseFrogCommand('/frog swim')).toBeUndefined()
    expect(commandAssistance('/fro')?.completions ?? []).toEqual([])
  })

  it('renders distinct hop, fly-catching, peek, and firefly frames', () => {
    const frames = [
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'hop', 0.5, 900),
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'fly', 0.7, 1_680),
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'peek', 0.5, 1_100),
      renderFrogAnimationRuns(60, FROG_ANIMATION_HEIGHT, 'firefly', 0.66, 2_500),
    ].map((runs) => runs.map((run) => run.text).join(''))

    for (const frame of frames) {
      expect(frame).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛█]/u)
    }
    expect(new Set(frames)).toHaveLength(4)
  })

  it('moves lateral frog animations from right to left in multiple stages', () => {
    const hopCenters = [0.12, 0.37, 0.62, 0.87].map((progress) =>
      visibleCenter(renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'hop', progress, progress * 3_000))
    )
    const flyLead = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'fly', 0.06, 204)
    const flyAhead = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'fly', 0.18, 612)
    const chase = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'fly', 0.4, 1_360)
    const fireflyArrival = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'firefly', 0.34, 1_292)
    const fireflyExit = renderFrogAnimationRuns(80, FROG_ANIMATION_HEIGHT, 'firefly', 0.9, 3_420)

    expect(hopCenters[0]).toBeGreaterThan(hopCenters[1]!)
    expect(hopCenters[1]).toBeGreaterThan(hopCenters[2]!)
    expect(hopCenters[2]).toBeGreaterThan(hopCenters[3]!)
    expect(visibleCenter(flyLead)).toBeGreaterThan(visibleCenter(flyAhead))
    expect(visibleCharacters(chase)).toBeGreaterThan(visibleCharacters(flyAhead))
    expect(visibleCenter(fireflyArrival)).toBeGreaterThan(visibleCenter(fireflyExit))
  })

  it('renders the frog over the existing conversation instead of replacing it', async () => {
    const target = backend()
    target.stream = async function* () {
      yield { type: 'textDelta', text: 'Conversation stays visible' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target, {
      settings: { animations: false },
    })
    await controller.submit('Keep this on screen')

    const output = renderToString(
      createElement(ChatView, {
        snapshot: controller.getSnapshot(),
        input: '',
        cursor: 0,
        terminalWidth: 80,
        terminalHeight: 40,
        frog: { id: 1, variant: 'hop' },
        onFrogComplete: () => {},
      }),
      { columns: 80 }
    )

    expect(output).toContain('Conversation stays visible')
    expect(output).toMatch(/[▗▖▄▝▐▞▟▘▚▌▙▀▜▛█]/u)
  })

  it('handles the command in the TUI without creating a conversation turn', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
    const target = backend()
    const controller = new ChatController(target, {
      settings: { animations: false },
    })
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    instances.push(instance)

    input.write('/frog peek')
    await instance.waitUntilRenderFlush()
    input.write('\r')

    await instance.waitUntilRenderFlush()
    expect(controller.getSnapshot().completedTurns).toEqual([])
    expect(target.stream).not.toHaveBeenCalled()
  })
})

describe('/strands', () => {
  it('uses the platform browser command without shell interpolation', () => {
    const url = 'https://strandsagents.com'

    expect(externalUrlCommand('darwin', url)).toEqual({ command: 'open', args: [url] })
    expect(externalUrlCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] })
    expect(externalUrlCommand('win32', url)).toEqual({ command: 'cmd', args: ['/c', 'start', '', url] })
  })

  it('opens the website without appearing in suggestions or creating a turn', async () => {
    const input = ttyInput()
    const target = backend()
    const controller = new ChatController(target)
    const openUrl = vi.fn()
    const instance = render(createElement(ChatApp, { controller, openUrl }), {
      stdin: input,
      stdout: ttyOutput(80, 20),
      stderr: ttyOutput(80, 20),
      exitOnCtrlC: false,
      patchConsole: false,
    })
    instances.push(instance)

    input.write('/strands')
    await instance.waitUntilRenderFlush()
    input.write('\r')

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://strandsagents.com'))
    expect(commandAssistance('/stra')?.completions ?? []).toEqual([])
    expect(controller.getSnapshot().completedTurns).toEqual([])
    expect(target.stream).not.toHaveBeenCalled()
  })
})

function backend(): ChatBackend {
  return {
    id: 'frog-test',
    name: 'Strands harness',
    protocol: 'strands',
    stream: vi.fn(),
    cancel() {},
  }
}

function visibleCenter(runs: FrogAnimationRun[]): number {
  const columns = runs.flatMap((run) => [run.column, run.column + [...run.text].length - 1])
  return (Math.min(...columns) + Math.max(...columns)) / 2
}

function visibleCharacters(runs: FrogAnimationRun[]): number {
  return runs.reduce((count, run) => count + [...run.text].filter((character) => character !== ' ').length, 0)
}
