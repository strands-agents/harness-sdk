import { createElement, type ReactElement } from 'react'
import { Text, type Instance } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ChatController,
  type ChatControllerApi,
  type DevChatCommand,
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

const MARKER = 'docked-panel-body'

const probe = (dock: boolean): { command: DevChatCommand; widths: number[] } => {
  const widths: number[] = []
  const ProbePanel = ({ width }: DevChatPanelProps): ReactElement => {
    widths.push(width)
    return createElement(Text, null, MARKER)
  }
  return {
    command: {
      spec: { name: 'probe', usage: '/probe', description: 'Probe' },
      sticky: true,
      ...(dock ? { dock: true } : {}),
      open: () => ProbePanel,
    },
    widths,
  }
}

const mount = async (command: DevChatCommand, columns: number) => {
  const controller = new ChatController(idleBackend(), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [command],
  })
  const input = ttyInput()
  const output = ttyOutput(columns, 40)
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
  controller.openDevCommand('probe')
  await instance.waitUntilRenderFlush()
  return { screen: (): string => frame }
}

describe('a dev panel that asks for the dock', () => {
  it('shouldRenderNarrowerThanTheTerminalSoTheTranscriptKeepsTheRest', async () => {
    const docked = probe(true)
    await mount(docked.command, 120)

    const width = docked.widths.at(-1)!
    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThan(120 / 2)
  })

  it('shouldTakeTheFullWidthWhenItDoesNotAskForTheDock', async () => {
    const inline = probe(false)
    await mount(inline.command, 120)

    expect(inline.widths.at(-1)!).toBeGreaterThan(120 / 2)
  })

  it('shouldFallBackToTheInlinePanelOnANarrowTerminal', async () => {
    const docked = probe(true)
    await mount(docked.command, 70)

    expect(docked.widths.at(-1)!).toBeGreaterThan(70 / 2)
  })
})
