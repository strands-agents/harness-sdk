import { createElement } from 'react'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatApp, numberSettingEdit } from '../../src/ui/chat/screen.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { settingArrowValue } from '../../src/ui/interaction.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const DOWN = '\u001b[B'
const ESCAPE = '\u001b'
const BACKSPACE = '\u007f'

const rendered: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of rendered.splice(0)) await dispose()
})

describe('numberSettingEdit', () => {
  it('shouldAppendDigitsAndDropLeadingZeros', () => {
    expect(numberSettingEdit('', 9999, '2', {})).toBe('2')
    expect(numberSettingEdit('2', 9999, '5', {})).toBe('25')
    expect(numberSettingEdit('0', 9999, '7', {})).toBe('7')
    expect(numberSettingEdit('', 9999, '0', {})).toBe('0')
    expect(numberSettingEdit('', 9999, '120', {})).toBe('120')
  })

  it.each(['a', ' ', '.', '-', '+', 'e', '1.5', '-5', '1e2', '２', ''])('shouldNotTake %j', (character) => {
    expect(numberSettingEdit('12', 9999, character, {})).toBeUndefined()
  })

  it('shouldNotTakeADigitThatIsHeldWithControlOrMeta', () => {
    expect(numberSettingEdit('12', 9999, '3', { ctrl: true })).toBeUndefined()
    expect(numberSettingEdit('12', 9999, '3', { meta: true })).toBeUndefined()
  })

  it('shouldKeepTheDigitsWhenOneMoreWouldPassTheMaximum', () => {
    expect(numberSettingEdit('9999', 9999, '9', {})).toBe('9999')
    expect(numberSettingEdit('1', 100, '00', {})).toBe('100')
    expect(numberSettingEdit('10', 100, '1', {})).toBe('10')
  })

  it('shouldDeleteTheLastDigitAndClearWithControlU', () => {
    expect(numberSettingEdit('25', 9999, '', { backspace: true })).toBe('2')
    expect(numberSettingEdit('25', 9999, '', { delete: true })).toBe('2')
    expect(numberSettingEdit('', 9999, '', { backspace: true })).toBe('')
    expect(numberSettingEdit('25', 9999, 'u', { ctrl: true })).toBe('')
  })
})

describe('auto-optimize in the workspace settings', () => {
  const open = async (autoOptimize?: number) => {
    const setSettings = vi.fn(async () => undefined)
    const controller = new ChatController(idleBackend(), {
      settings: { animations: false, ...(autoOptimize === undefined ? {} : { autoOptimize }) },
      runtime: {
        devWorkspace: {
          root: '/project/strands-dev',
          entrypoint: '/project/agent.ts',
          boundEntrypoint: '/project/agent.ts',
          origin: 'discovered',
        },
      },
      workspaceAction: vi.fn(),
      setSettings,
    })
    const input = ttyInput()
    const output = ttyOutput(120, 30)
    const frame = captureFrame(output)
    const instance = render(createElement(ChatApp, { controller }), {
      stdin: input,
      stdout: output,
      stderr: ttyOutput(120, 30),
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    })
    rendered.push(async () => {
      instance.unmount()
      await controller.dispose()
    })
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys) {
        input.write(key)
        await new Promise((resolve) => setTimeout(resolve, 20))
        await instance.waitUntilRenderFlush()
      }
    }
    const line = (): string => frame().find((text) => text.includes('Auto-optimize every N turns')) ?? ''
    const footer = (): string => frame().join('\n')
    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })
    await vi.waitFor(() => expect(line()).toContain('Auto-optimize every N turns'))
    await press('\t')
    for (let moves = 0; moves < 8 && !line().includes('› Auto-optimize'); moves += 1) await press(DOWN)
    expect(line()).toContain('› Auto-optimize')
    const row = () => controller.getSnapshot().panel?.rows.find(({ value }) => value === 'autoOptimize')
    return { controller, setSettings, press, line, footer, row }
  }

  it('shouldShowAFieldThatReadsOffAndNoPresetChoices', async () => {
    const { line, row } = await open()

    expect(row()?.control).toEqual({ kind: 'number', value: '0', max: 9999 })
    expect(line()).toMatch(/\[ Off\s+\]/u)
    expect(line()).not.toMatch(/\b(5|10|20|50|100)\b/u)
  })

  it('shouldSaveTheTypedWholeNumberOnEnterAndNotBefore', async () => {
    const { controller, setSettings, press, line, footer } = await open()

    await press('3', '7')

    expect(line()).toMatch(/\[ 37\s+\]/u)
    expect(footer()).toContain('Enter save · Esc cancel')
    expect(setSettings).not.toHaveBeenCalled()

    await press('\r')

    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoOptimize: 37 }))
    expect(controller.getSnapshot().settings.autoOptimize).toBe(37)
    await vi.waitFor(() => expect(footer()).not.toContain('Enter save · Esc cancel'))
    expect(line()).toMatch(/\[ 37\s+\]/u)
  })

  it('shouldIgnoreEveryKeyThatIsNotADigit', async () => {
    const { setSettings, press, line } = await open()

    await press('a', '1', '.', '-', ' ', '2', 'e', '+')

    expect(line()).toMatch(/\[ 12\s+\]/u)

    await press('\r')

    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoOptimize: 12 }))
  })

  it('shouldEditTheSavedNumberAndTurnItOffWhenTheFieldIsEmptied', async () => {
    const { setSettings, press, line } = await open(20)

    expect(line()).toMatch(/\[ 20\s+\]/u)

    await press(BACKSPACE, '5')

    expect(line()).toMatch(/\[ 25\s+\]/u)

    await press(BACKSPACE, BACKSPACE, '\r')

    await vi.waitFor(() => expect(setSettings).toHaveBeenCalledExactlyOnceWith({ autoOptimize: 0 }))
    await vi.waitFor(() => expect(line()).toMatch(/\[ Off\s+\]/u))
  })

  it('shouldDropTheDraftOnEscapeAndKeepThePanelOpen', async () => {
    const { controller, setSettings, press, line } = await open(20)

    await press('5')
    expect(line()).toMatch(/\[ 205\s+\]/u)

    await press(ESCAPE)

    await vi.waitFor(() => expect(line()).toMatch(/\[ 20\s+\]/u))
    expect(controller.getSnapshot().panel?.kind).toBe('settings')
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('shouldDropTheDraftWhenTheSelectionLeavesTheRow', async () => {
    const { setSettings, press, line } = await open(20)

    await press('5', '\u001b[A', DOWN)

    await vi.waitFor(() => expect(line()).toMatch(/\[ 20\s+\]/u))
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('shouldNotChangeWithTheArrowKeys', async () => {
    const { setSettings, press, row } = await open(20)

    await press('\u001b[C', '\u001b[D')

    expect(settingArrowValue(row()!, 1)).toBeUndefined()
    expect(settingArrowValue(row()!, -1)).toBeUndefined()
    expect(setSettings).not.toHaveBeenCalled()
  })
})
