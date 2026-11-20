import { createElement } from 'react'
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { type Instance } from 'ink'

import type { ChatBackend } from '../../src/agent/types.js'
import { ChatController, type ChatControllerApi, type DevChatCommand } from '../../src/ui/chat/controller.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { WizardRequestPanel } from '../../src/ui/panels/wizard-request-panel.js'
import { WizardBroker, wizardRequestRows, type WizardRequestSpec } from '../../src/ui/panels/wizard-request.js'
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

const question: WizardRequestSpec = {
  name: 'optimize',
  question: 'Describe the optimization you want, or answer "step by step".',
  steps: [
    {
      key: 'question',
      title: 'Question',
      fields: [{ kind: 'text', key: 'request', label: 'request', placeholder: 'step by step' }],
    },
  ],
}

/** Streams the ask call and holds the turn open on it, the way the real tool does. */
const askingBackend = (broker: WizardBroker, answered: Promise<unknown>): ChatBackend =>
  idleBackend({
    async *stream() {
      yield { type: 'toolStart', toolUseId: 'use-1', name: 'strands_dev_ask', input: { ask: 'text' } } as never
      void broker.ask(question)
      await answered
      yield {
        type: 'toolResult',
        toolUseId: 'use-1',
        status: 'success',
        content: [{ type: 'text', text: '{"status":"answered"}' }],
      } as never
      return { stopReason: 'endTurn' }
    },
  })

const askCommand = (broker: WizardBroker): DevChatCommand => ({
  spec: { name: 'ask', usage: '/ask', description: 'Ask' },
  sticky: true,
  dropPending: () => broker.cancelAll(),
  contentRows: () => wizardRequestRows(broker.pending()),
  attach: (context) => broker.attachOpener(() => context.openPanel('ask')),
  open: () => (props) => createElement(WizardRequestPanel, { ...props, broker }),
})

const mount = async (broker: WizardBroker, answered: Promise<unknown>, rows = 30) => {
  const controller = new ChatController(askingBackend(broker, answered), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [askCommand(broker)],
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
  return { controller, press, screen: (): string => frame }
}

const openQuestion = async () => {
  const broker = new WizardBroker()
  let resolve = (): void => {}
  const answered = new Promise<void>((done) => {
    resolve = done
  })
  const view = await mount(broker, answered)
  for (const character of 'optimize') await view.press(character)
  await view.press('\r')
  await new Promise((done) => setTimeout(done, 50))
  return { ...view, broker, resolve }
}

describe('a real ask call with its question on screen', () => {
  it('shouldShowTheCursorOnlyOnceFocusMovesIntoTheQuestion', async () => {
    const { press, screen, resolve } = await openQuestion()

    expect(screen()).not.toContain('›')
    expect(screen()).toContain('↑ answer this')

    await press('\u001b[A')

    expect(screen()).toContain('›')
    expect(screen()).not.toContain('↑ answer this')
    resolve()
  })

  it('shouldShowOnlyTheQuestion', async () => {
    const broker = new WizardBroker()
    let resolve = (): void => {}
    const answered = new Promise<void>((done) => {
      resolve = done
    })
    const { press, screen } = await mount(broker, answered)

    for (const character of 'optimize') await press(character)
    await press('\r')
    await new Promise((done) => setTimeout(done, 50))
    const shown = screen()
    writeFileSync('/tmp/ask-integration.txt', shown)

    expect(shown).toContain('Describe the optimization you want')
    expect(shown).not.toContain('Tool activity')
    expect(shown).not.toContain('Waiting for your answer')
    expect(shown).not.toContain('Viewing /ask')
    expect(shown).toContain('Enter to send')
    expect(shown).toContain('↑ answer this')
    expect(shown).not.toContain('›')
    resolve()
  })
})
