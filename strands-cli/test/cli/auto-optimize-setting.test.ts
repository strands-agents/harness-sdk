import { describe, expect, it } from 'vitest'

import {
  AUTO_OPTIMIZE_OPTIONS,
  DEFAULT_CHAT_SETTINGS,
  parseSettings,
  parseSettingUpdate,
  settingDescription,
  settingValue,
  SETTING_DEFINITIONS,
} from '../../src/config/settings.js'

const cadence = (saved: Record<string, unknown>) => settingValue(parseSettings(saved), 'autoOptimize')

describe('autoOptimize setting', () => {
  it('shouldDefaultToOffWithoutAKeyInThePlainSettings', () => {
    expect(DEFAULT_CHAT_SETTINGS).not.toHaveProperty('autoOptimize')
    expect(settingValue(DEFAULT_CHAT_SETTINGS, 'autoOptimize')).toBe(0)
  })

  it('shouldAppearInTheWorkspaceSectionAsAChoiceOfHowManyTurns', () => {
    const definition = SETTING_DEFINITIONS.find(({ key }) => key === 'autoOptimize')

    expect(definition).toMatchObject({
      label: 'Auto-optimize every N turns',
      section: 'Workspace',
      control: 'segmented',
    })
    expect(definition?.options).toBe(AUTO_OPTIMIZE_OPTIONS)
    expect(AUTO_OPTIMIZE_OPTIONS.map(({ label, value }) => [label, value])).toEqual([
      ['Off', 0],
      ['5', 5],
      ['10', 10],
      ['20', 20],
      ['50', 50],
      ['100', 100],
    ])
  })

  it('shouldTakeTheChoiceThatIsPicked', () => {
    expect(parseSettingUpdate('autoOptimize=20', DEFAULT_CHAT_SETTINGS)).toEqual({ autoOptimize: 20 })
    expect(parseSettingUpdate('autoOptimize=0', { ...DEFAULT_CHAT_SETTINGS, autoOptimize: 20 })).toEqual({
      autoOptimize: 0,
    })
  })

  it.each(['autoOptimize', 'autoOptimize=7', 'autoOptimize=true'])('shouldChangeNothingFor %s', (update) => {
    expect(parseSettingUpdate(update, DEFAULT_CHAT_SETTINGS)).toBeUndefined()
  })

  it('shouldReadTheSavedCadenceAndTakeAnythingElseAsOff', () => {
    expect(cadence({ autoOptimize: 50 })).toBe(50)
    expect(cadence({})).toBe(0)
    expect(cadence({ autoOptimize: 7 })).toBe(0)
    expect(cadence({ autoOptimize: '20' })).toBe(0)
  })

  it('shouldSayThatItWorksInTheBackgroundAndIsPaidWhenItIsOn', () => {
    expect(settingDescription({ ...DEFAULT_CHAT_SETTINGS, autoOptimize: 20 }, 'autoOptimize')).toBe(
      'every 20 chat turns · in the background, makes an experiment from your chats and optimizes on it · paid'
    )
    expect(settingDescription(DEFAULT_CHAT_SETTINGS, 'autoOptimize')).toBe(
      'off · an optimization runs only when you start one'
    )
  })
})
