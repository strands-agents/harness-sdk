import { createElement } from 'react'
import { type Instance } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import { createDiffPreview } from '../../src/agent/file-changes.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { ChatController, type ChatControllerApi, type DevChatCommand } from '../../src/ui/chat/controller.js'
import { ChatApp } from '../../src/ui/chat/screen.js'
import { WizardRequestPanel } from '../../src/ui/panels/wizard-request-panel.js'
import {
  WizardBroker,
  wizardRequestHasDiff,
  wizardRequestRows,
  type WizardRequestSpec,
} from '../../src/ui/panels/wizard-request.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const mounted: { instance: Instance; controller: ChatControllerApi }[] = []

afterEach(async () => {
  for (const { instance, controller } of mounted.splice(0)) {
    instance.unmount()
    await instance.waitUntilExit()
    await controller.dispose()
  }
})

const UP = '\u001b[A'
const PAGE_DOWN = '\u001b[6~'
const WHEEL_DOWN = 65

const OLD_PROMPT = Array.from({ length: 24 }, (_, index) => `Rule ${index + 1}: keep the answer short.`).join('\n')
const NEW_PROMPT = OLD_PROMPT.replace('Rule 2:', 'Rule 2 (first):').replace('Rule 23:', 'Rule 23 (last):')

const review: WizardRequestSpec = {
  name: 'optimize',
  titleParts: ['20261122-162600-prefix-smoke'],
  question: 'Apply this change to instructions?',
  standing: true,
  steps: [
    {
      key: 'review',
      title: 'Review',
      fields: [
        {
          kind: 'select',
          key: 'verdict',
          multiple: false,
          options: [
            { value: 'accept', label: 'Apply this change' },
            { value: 'reject', label: 'Leave it as it is' },
          ],
        },
        {
          kind: 'diff',
          key: 'change',
          label: 'instructions',
          path: 'agent.ts',
          diff: createDiffPreview('agent.ts', OLD_PROMPT, NEW_PROMPT),
        },
      ],
    },
  ],
}

const askCommand = (broker: WizardBroker): DevChatCommand => ({
  spec: { name: 'ask', usage: '/ask', description: 'Ask' },
  sticky: true,
  dock: () => wizardRequestHasDiff(broker.pending()),
  wideDock: () => wizardRequestHasDiff(broker.pending()),
  dropPending: () => broker.dropForTurn(),
  contentRows: (width) => wizardRequestRows(broker.pending(), width),
  attach: (context) => broker.attachOpener(() => context.openPanel('ask')),
  open: () => (props) => createElement(WizardRequestPanel, { ...props, broker }),
})

const mount = async (columns: number, rows: number) => {
  const broker = new WizardBroker()
  const controller = new ChatController(idleBackend(), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [askCommand(broker)],
  })
  const input = ttyInput()
  const output = ttyOutput(columns, rows)
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
  const asked = broker.ask(review)
  await instance.waitUntilRenderFlush()
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  const lines = (): string[] => frame.split('\n')
  const row = (text: string): number => lines().findIndex((line) => line.includes(text))
  return { asked, broker, controller, press, lines, row, screen: (): string => frame }
}

describe('a finished run’s review in the chat', () => {
  it.each([
    [80, 24, '+ Rule 2 (first): keep the answer short.'],
    [89, 30, '+ Rule 2 (first): keep the answer short.'],
    [60, 20, '@@ -1,5 +1,5 @@'],
  ])('shouldShowTheChangeAndBothChoicesAboveTheInputAt%ix%i', async (columns, rows, line) => {
    const { screen, row } = await mount(columns, rows)

    expect(screen()).toContain('agent.ts · +2 -2 lines')
    expect(screen()).toContain('@@ -1,5 +1,5 @@')
    expect(screen()).toContain(line)
    expect(screen()).toContain('○ Apply this change')
    expect(screen()).toContain('○ Leave it as it is')
    expect(screen()).toMatch(/↓ \d+ more/u)
    expect(row('○ Leave it as it is')).toBeLessThan(row('Enter to send'))
    expect(screen().split('\n').length).toBeLessThanOrEqual(rows)
  })

  it('shouldScrollTheChangeWithPageDownOnceTheQuestionHoldsTheKeyboard', async () => {
    const { press, screen } = await mount(80, 24)
    expect(screen()).not.toContain('Rule 23 (last)')

    await press(UP)
    await press(PAGE_DOWN)
    await press(PAGE_DOWN)
    await press(PAGE_DOWN)

    expect(screen()).toContain('+ Rule 23 (last): keep the answer short.')
    expect(screen()).toContain('› ○ Apply this change')
  })

  it('shouldScrollTheChangeWithTheWheelWhileTheChatHoldsTheKeyboard', async () => {
    const { press, row, screen } = await mount(80, 24)
    const over = row('- Rule 2: keep the answer short.')
    expect(over).toBeGreaterThan(0)

    for (let turn = 0; turn < 8; turn++) await press(mouseInputSequence(WHEEL_DOWN, 10, over, 'M'))

    expect(screen()).toContain('+ Rule 23 (last): keep the answer short.')
    expect(screen()).toContain('↑ answer this')
  })

  it('shouldShowTheChangeBesideTheChatOnAWideTerminal', async () => {
    const { lines, row, screen } = await mount(120, 40)

    expect(screen()).toContain('+ Rule 2 (first): keep the answer short.')
    expect(screen()).toContain('+ Rule 23 (last): keep the answer short.')
    expect(lines()[row('○ Apply this change')]!.indexOf('○')).toBeGreaterThan(40)
    expect(screen()).not.toMatch(/↓ \d+ more/u)
  })
})
