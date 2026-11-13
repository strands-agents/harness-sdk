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

const ARTWORK = /[█▀▄▟▙]/u

const mounted: { instance: Instance; controller: ChatControllerApi }[] = []

afterEach(async () => {
  for (const { instance, controller } of mounted.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
})

const panelCommand = (): DevChatCommand => {
  const Panel = (_props: DevChatPanelProps): ReactElement => createElement(Text, null, 'probe panel')
  return { spec: { name: 'probe', usage: '/probe', description: 'Probe' }, open: () => Panel }
}

const artwork = (frame: string): readonly string[] => frame.split('\n').filter((line) => ARTWORK.test(line))

const mount = async (rows = 40) => {
  const controller = new ChatController(idleBackend(), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [panelCommand()],
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
  return {
    frame: (): string => frame,
    submit: async (command: string): Promise<void> => {
      await controller.submit(command)
      await instance.waitUntilRenderFlush()
    },
  }
}

describe('startup logo with a dev panel', () => {
  it.each([40, 30, 24, 20])('shouldKeepTheLogoAtItsSizeWhenADevPanelOpensIn %i rows', async (rows) => {
    const screen = await mount(rows)
    const before = artwork(screen.frame())

    await screen.submit('/probe')

    expect(screen.frame()).toContain('probe panel')
    expect(before.length).toBeGreaterThan(1)
    expect(artwork(screen.frame())).toEqual(before)
  })

  it('shouldGiveTheRowsOfTheLogoPaddingToThePanelWhenTheScreenIsShort', async () => {
    const screen = await mount(40)
    const logoTop = (): number =>
      screen
        .frame()
        .split('\n')
        .findIndex((line) => ARTWORK.test(line))
    const before = logoTop()

    await screen.submit('/probe')

    expect(before).toBeGreaterThan(logoTop())
    expect(logoTop()).toBeGreaterThanOrEqual(0)
  })
})
