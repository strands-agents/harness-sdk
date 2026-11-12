import { createElement, useState, type ReactElement } from 'react'
import { Text, useInput, type Instance } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const mount = async (command: DevChatCommand, rows = 40) => {
  const controller = new ChatController(idleBackend(), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [command],
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
  return { controller, instance, press, screen: (): string => frame, row }
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
