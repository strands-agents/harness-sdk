import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CHAT_SETTINGS,
  parseSettings,
  parseSettingUpdate,
  settingDescription,
  SETTING_DEFINITIONS,
} from '../../src/config/settings.js'

describe('uiAutofill setting', () => {
  it('shouldDefaultToOff', () => {
    expect(DEFAULT_CHAT_SETTINGS.uiAutofill).toBe(false)
  })

  it('shouldAppearInTheWorkspaceSectionAsAToggle', () => {
    const definition = SETTING_DEFINITIONS.find(({ key }) => key === 'uiAutofill')

    expect(definition).toMatchObject({ label: 'Autofill agent questions', section: 'Workspace', control: 'toggle' })
  })

  it('shouldFlipWhenTheRowIsActivated', () => {
    expect(parseSettingUpdate('uiAutofill', DEFAULT_CHAT_SETTINGS)).toEqual({ uiAutofill: true })
  })

  it('shouldReadTheSavedValue', () => {
    expect(parseSettings({ uiAutofill: true }).uiAutofill).toBe(true)
    expect(parseSettings({}).uiAutofill).toBe(false)
  })

  it.each([
    [true, 'on · the agent answers its own questions'],
    [false, 'off · the agent asks, and you answer on screen'],
  ])('shouldExplainWhatItDoesWhenItIs%s', (uiAutofill, text) => {
    expect(settingDescription({ ...DEFAULT_CHAT_SETTINGS, uiAutofill }, 'uiAutofill')).toContain(text)
  })
})
