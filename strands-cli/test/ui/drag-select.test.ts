import { createElement } from 'react'
import { type Instance } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import { ChatController, type ChatControllerApi } from '../../src/ui/chat/controller.js'
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

const mount = async (rows = 30) => {
  const controller = new ChatController(idleBackend(), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
  })
  const input = ttyInput()
  const output = ttyOutput(100, rows)
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
  return { press, screen: (): string => frame, controller }
}

describe('selecting text with the mouse', () => {
  it('shouldPaintTheTextThatIsThereNowWhenTheScreenChangesMidDrag', async () => {
    const { press, screen, controller } = await mount()
    for (const character of 'first line of text') await press(character)
    await press('\r')
    const row = screen()
      .split('\n')
      .findIndex((line) => line.includes('first line of text'))
    expect(row).toBeGreaterThanOrEqual(0)

    await press(`\u001b[<0;4;${row + 1}M`)
    controller.notify?.('success', 'a notice that shifts the screen')
    await press(`\u001b[<32;12;${row + 1}M`)

    const painted = screen()
      .split('\n')
      .filter((line) => line.includes('first line of text'))
    expect(painted.length).toBeLessThanOrEqual(1)
    expect(screen()).not.toContain('first line of textfirst')
  })

  it('shouldLeaveTheTextUnchangedWhileDraggingAcrossIt', async () => {
    const { press, screen } = await mount()
    for (const character of 'selectable words here') await press(character)
    await press('\r')
    const before = screen()
    const row = before.split('\n').findIndex((line) => line.includes('selectable words here'))
    expect(row).toBeGreaterThanOrEqual(0)

    await press(`\u001b[<0;4;${row + 1}M`)
    await press(`\u001b[<32;10;${row + 1}M`)
    await press(`\u001b[<32;18;${row + 1}M`)
    const during = screen()
    await press(`\u001b[<0;18;${row + 1}m`)

    expect(during).toContain('selectable words here')
    expect(screen()).toContain('selectable words here')
  })
})
