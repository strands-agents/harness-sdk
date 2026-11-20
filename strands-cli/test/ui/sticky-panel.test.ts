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

const askCommand = (dropPending?: () => void): DevChatCommand => {
  const Panel = ({ close, active = true, blur }: DevChatPanelProps): ReactElement => {
    const [keys, setKeys] = useState('')
    useInput(
      (input, key) => {
        if (key.escape) close()
        else if (key.downArrow) blur?.()
        else setKeys((current) => current + input)
      },
      { isActive: active }
    )
    return createElement(Text, null, `question keys:[${keys}]`)
  }
  return {
    spec: { name: 'ask', usage: '/ask', description: 'Ask' },
    sticky: true,
    ...(dropPending ? { dropPending } : {}),
    open: () => Panel,
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
  return { controller, press, screen: (): string => frame }
}

describe('a dev command that runs instead of opening', () => {
  it('shouldSubmitItsPromptAndOpenNoPanel', async () => {
    const command: DevChatCommand = {
      spec: { name: 'go', usage: '/go', description: 'Go' },
      run: (context) => context.submit('optimize'),
      open: () => () => null,
    }
    const { controller, press, screen } = await mount(command)

    await press('/go')
    await press('\r')

    await vi.waitFor(() => expect(screen()).toContain('optimize'))
    expect(controller.getSnapshot().panel).toBeUndefined()
  })
})

describe('a sticky question panel', () => {
  it('shouldTypeIntoTheChatInputAfterLeavingWhileTheQuestionStaysOnScreen', async () => {
    const { controller, press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')
    expect(screen()).toContain('question keys:[]')

    await press('\u001b[B')
    await press('h')
    await press('i')

    expect(screen()).toContain('question keys:[]')
    expect(screen()).toContain('hi')
    expect(controller.getSnapshot().panel?.kind).toBe('dev')
  })

  it('shouldSubmitToTheAgentWhileTheQuestionStaysOnScreen', async () => {
    const { controller, press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')
    await press('\u001b[B')

    await press('h')
    await press('e')
    await press('y')
    await press('\r')

    expect(screen()).toContain('question keys:[]')
    expect(controller.getSnapshot().panel?.kind).toBe('dev')
    expect(screen()).toContain('hey')
  })

  it('shouldLeaveTheQuestionOpenWhenTheDeveloperClicksTheInput', async () => {
    const { controller, press } = await mount(askCommand())
    await press('/ask')
    await press('\r')

    await press('\u001b[<0;10;37M')
    await press('\u001b[<0;10;37m')

    expect(controller.getSnapshot().panel?.kind).toBe('dev')
  })

  it('shouldMoveBetweenTheQuestionAndTheChatWithTheArrows', async () => {
    const { press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')

    await press('\u001b[B')
    await press('h')
    expect(screen()).toContain('question keys:[]')
    expect(screen()).toContain('h')

    await press('\u007f')
    await press('\u001b[A')
    await press('z')

    expect(screen()).toContain('question keys:[z]')
  })

  it('shouldDropThePendingQuestionAndSteerTheMessageIntoTheTurn', async () => {
    const dropped: number[] = []
    const { controller, press } = await mount(askCommand(() => dropped.push(1)))
    const steer = vi.spyOn(controller, 'steer')
    await press('/ask')
    await press('\r')
    await press('\u001b[B')

    await press('h')
    await press('i')
    await press('\r')

    expect(dropped).toEqual([1])
    expect(steer).toHaveBeenCalledWith('hi')
  })

  it('shouldKeepThePendingQuestionWhenTheDeveloperRunsACommand', async () => {
    const dropped: number[] = []
    const { press } = await mount(askCommand(() => dropped.push(1)))
    await press('/ask')
    await press('\r')
    await press('\u001b[B')

    await press('/settings')
    await press('\r')

    expect(dropped).toEqual([])
  })

  it('shouldKeepThePendingQuestionWhenTheInputIsEmpty', async () => {
    const dropped: number[] = []
    const { press } = await mount(askCommand(() => dropped.push(1)))
    await press('/ask')
    await press('\r')
    await press('\u001b[B')

    await press('\r')

    expect(dropped).toEqual([])
  })

  it('shouldNotTakeTheKeyboardBackWhileTheDeveloperDragsToSelectText', async () => {
    const { press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')
    await press('\u001b[B')
    const row = screen()
      .split('\n')
      .findIndex((line) => line.includes('question keys:'))
    expect(row).toBeGreaterThanOrEqual(0)
    const composer = (): string =>
      screen()
        .split('\n')
        .filter((line) => line.includes('Viewing /ask') || line.includes('Enter drops the question'))
        .join()
    const before = composer()

    await press(`\u001b[<0;6;${row + 1}M`)
    await press(`\u001b[<32;12;${row + 1}M`)
    await press(`\u001b[<32;20;${row + 1}M`)

    expect(composer()).toBe(before)
  })

  it('shouldSayEnterSendsOnBothSidesOfAQuestion', async () => {
    const { press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')

    expect(screen()).toContain('Enter to send')
    expect(screen()).not.toContain('Viewing /ask')

    await press('\u001b[A')

    expect(screen()).toContain('Enter to send')
    expect(screen()).not.toContain('Viewing /ask')
  })

  it('shouldLeaveTheKeyboardWithTheChatWhenAQuestionOpens', async () => {
    const { press, screen } = await mount(askCommand())

    await press('/ask')
    await press('\r')

    expect(screen()).toContain('question keys:[]')
    expect(screen()).not.toContain('Viewing /ask')
  })

  it('shouldTakeTheKeyboardForAPanelThatIsNotSticky', async () => {
    const { sticky, ...plain } = askCommand()
    void sticky
    const { press, screen } = await mount(plain)

    await press('/ask')
    await press('\r')
    await press('x')

    expect(screen()).toContain('question keys:[x]')
  })

  it('shouldSendKeysToTheChatUntilUpMovesIntoTheQuestion', async () => {
    const { press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')

    await press('x')
    expect(screen()).toContain('question keys:[]')

    await press('\u007f')
    await press('\u001b[A')
    await press('x')

    expect(screen()).toContain('question keys:[x]')
  })

  it('shouldTakeTheKeyboardBackOnUpFromAnEmptyInput', async () => {
    const { press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')
    await press('\u001b[B')

    await press('\u001b[A')
    await press('z')

    expect(screen()).toContain('question keys:[z]')
  })

  it('shouldKeepTheInputWhenUpArrivesWithTextTyped', async () => {
    const { press, screen } = await mount(askCommand())
    await press('/ask')
    await press('\r')
    await press('\u001b[B')
    await press('a')

    await press('\u001b[A')
    await press('z')

    expect(screen()).toContain('question keys:[]')
  })
})
