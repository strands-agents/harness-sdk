import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { type Instance } from 'ink'

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

const twoOptions: WizardRequestSpec = {
  name: 'Optimize',
  question: 'Would you like step-by-step setup, or to describe the optimization you want?',
  steps: [
    {
      key: 'question',
      title: 'Question',
      fields: [
        {
          kind: 'select',
          key: 'mode',
          multiple: false,
          selected: ['steps'],
          options: [
            { value: 'steps', label: 'Step by step', detail: 'Choose the experiment, what may change, and the goal.' },
            { value: 'describe', label: 'Describe it', detail: 'Tell me your goal and any limits.' },
          ],
        },
      ],
    },
  ],
}

const mount = async (command: DevChatCommand, rows = 30) => {
  const controller = new ChatController(idleBackend(), {
    settings: { animations: false },
    runtime: { model: 'model-00', cwd: '/work' },
    devCommands: [command],
  })
  const input = ttyInput()
  const output = ttyOutput(110, rows)
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
  return { press, screen: (): string => frame }
}

const askCommand = (broker: WizardBroker): DevChatCommand => ({
  spec: { name: 'ask', usage: '/ask', description: 'Ask' },
  sticky: true,
  contentRows: () => wizardRequestRows(broker.pending()),
  open: () => (props) => createElement(WizardRequestPanel, { ...props, broker }),
})

describe('wizardRequestRows', () => {
  it('shouldCountTheQuestionItsOptionsAndOnePaddingRow', () => {
    expect(wizardRequestRows(undefined)).toBeUndefined()
    expect(wizardRequestRows({ ...twoOptions, id: 'r1' })).toBe(8)
  })

  it('shouldGrowWithTheOptionCount', () => {
    const five = {
      ...twoOptions,
      id: 'r2',
      steps: [
        {
          ...twoOptions.steps[0]!,
          fields: [
            {
              kind: 'select' as const,
              key: 'mode',
              multiple: false,
              options: ['a', 'b', 'c', 'd', 'e'].map((value) => ({ value, label: value })),
            },
          ],
        },
      ],
    }

    expect(wizardRequestRows(five)).toBe(11)
  })

  it('shouldSizeAWalkedFormToItsTallestStepPlusItsStepBar', () => {
    const single = wizardRequestRows({ ...twoOptions, id: 'r3' })!
    const taller = {
      ...twoOptions.steps[0]!,
      fields: [
        {
          kind: 'select' as const,
          key: 'more',
          multiple: false,
          options: ['a', 'b', 'c', 'd'].map((value) => ({ value, label: value })),
        },
      ],
    }
    const walked = { ...twoOptions, id: 'r4', steps: [twoOptions.steps[0]!, taller] }

    expect(wizardRequestRows(walked)).toBe(single + 2 + 2)
  })
})

describe('the panel around one question', () => {
  it('shouldFitTheQuestionRatherThanHalfTheScreen', async () => {
    const broker = new WizardBroker()
    void broker.ask(twoOptions)
    const { press, screen } = await mount(askCommand(broker))
    await press('/ask')
    await press('\r')

    const lines = screen().split('\n')
    const top = lines.findIndex((line) => line.includes('╭'))
    const bottom = lines.findIndex((line) => line.includes('╰'))

    expect(top).toBeGreaterThanOrEqual(0)
    expect(bottom - top).toBeLessThanOrEqual(9)
  })

  it.each([
    ['one step', 1],
    ['a walked form', 2],
  ])('shouldShowEveryOptionOfALongListIn%s', async (_name, stepCount) => {
    const labels = Array.from({ length: 10 }, (_, index) => `experiment-${index + 1}`)
    const step = (key: string) => ({
      key,
      title: key,
      fields: [
        {
          kind: 'select' as const,
          key,
          multiple: false,
          options: labels.map((label) => ({ value: label, label, detail: '5 cases' })),
        },
      ],
    })
    const broker = new WizardBroker()
    void broker.ask({ ...twoOptions, steps: Array.from({ length: stepCount }, (_, index) => step(`step${index}`)) })
    const { press, screen } = await mount(askCommand(broker), 50)
    await press('/ask')
    await press('\r')

    for (const label of labels) expect(screen()).toContain(label)
    expect(screen()).not.toMatch(/↓ \d+ more/u)
  })
})
