import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CHAT_SETTINGS,
  parseSettings,
  parseSettingUpdate,
  settingDescription,
  SETTING_DEFINITIONS,
} from '../../src/config/settings.js'

describe('autoOptimize setting', () => {
  it('shouldDefaultToOff', () => {
    expect(DEFAULT_CHAT_SETTINGS.autoOptimize).toBe(false)
  })

  it('shouldAppearInTheWorkspaceSectionAsAToggle', () => {
    const definition = SETTING_DEFINITIONS.find(({ key }) => key === 'autoOptimize')

    expect(definition).toMatchObject({ label: 'Auto-optimize (apply edits)', section: 'Workspace', control: 'toggle' })
  })

  it('shouldKeepItsLabelWithinTheLongestOfTheSectionSoNoRowIsCut', () => {
    const labels = SETTING_DEFINITIONS.filter(({ section }) => section === 'Workspace').map(({ label }) => label)

    expect(Math.max(...labels.map(({ length }) => length))).toBe('Sync model to existing sessions'.length)
  })

  it('shouldFlipWhenTheRowIsActivated', () => {
    expect(parseSettingUpdate('autoOptimize', DEFAULT_CHAT_SETTINGS)).toEqual({ autoOptimize: true })
    expect(parseSettingUpdate('autoOptimize', { ...DEFAULT_CHAT_SETTINGS, autoOptimize: true })).toEqual({
      autoOptimize: false,
    })
  })

  it('shouldReadTheSavedValue', () => {
    expect(parseSettings({ autoOptimize: true }).autoOptimize).toBe(true)
    expect(parseSettings({}).autoOptimize).toBe(false)
    expect(parseSettings({ autoOptimize: 'yes' }).autoOptimize).toBe(false)
  })

  it.each([
    [true, 'on · the edits of a finished optimization are written to the agent without a review'],
    [false, 'off · a finished optimization shows its edits, and you apply or leave each one'],
  ])('shouldExplainWhatItDoesWhenItIs%s', (autoOptimize, text) => {
    expect(settingDescription({ ...DEFAULT_CHAT_SETTINGS, autoOptimize }, 'autoOptimize')).toBe(text)
  })
})
