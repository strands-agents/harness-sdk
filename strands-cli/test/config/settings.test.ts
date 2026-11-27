import { describe, expect, it } from 'vitest'

import {
  AUTO_OPTIMIZE_MAX_TURNS,
  DEFAULT_CHAT_SETTINGS,
  parseSettings,
  parseSettingUpdate,
  settingDescription,
  settingValue,
  SETTING_DEFINITIONS,
} from '../../src/config/settings.js'

const effective = (saved: Record<string, unknown>) => {
  const settings = parseSettings(saved)
  return {
    autoAcceptOptimizationResults: settingValue(settings, 'autoAcceptOptimizationResults'),
    autoOptimize: settingValue(settings, 'autoOptimize'),
  }
}

describe('autoAcceptOptimizationResults setting', () => {
  it('shouldDefaultToOffWithoutAKeyInThePlainSettings', () => {
    expect(DEFAULT_CHAT_SETTINGS).not.toHaveProperty('autoAcceptOptimizationResults')
    expect(settingValue(DEFAULT_CHAT_SETTINGS, 'autoAcceptOptimizationResults')).toBe(false)
  })

  it('shouldAppearInTheWorkspaceSectionAsAToggle', () => {
    const definition = SETTING_DEFINITIONS.find(({ key }) => key === 'autoAcceptOptimizationResults')

    expect(definition).toMatchObject({
      label: 'Auto-accept optimization results',
      section: 'Workspace',
      control: 'toggle',
    })
  })

  it('shouldKeepTheLabelsOfTheSectionShortEnoughToShowWholeBesideTheirControls', () => {
    const labels = SETTING_DEFINITIONS.filter(({ section }) => section === 'Workspace').map(({ label }) => label)

    // A label of 42 columns was cut at 120 columns and pushed the workspace paths out of their row.
    expect(Math.max(...labels.map(({ length }) => length))).toBeLessThanOrEqual(32)
  })

  it('shouldTakeOverTheValueSavedUnderItsEarlierNameAutoOptimize', () => {
    expect(effective({ autoOptimize: true })).toEqual({ autoAcceptOptimizationResults: true, autoOptimize: 0 })
    expect(effective({ autoOptimize: false })).toEqual({ autoAcceptOptimizationResults: false, autoOptimize: 0 })
    expect(
      parseSettings({ autoOptimize: true, autoAcceptOptimizationResults: false }).autoAcceptOptimizationResults
    ).toBe(false)
    expect(effective({ autoOptimize: 20 })).toEqual({ autoAcceptOptimizationResults: false, autoOptimize: 20 })
  })

  it('shouldFlipWhenTheRowIsActivated', () => {
    expect(parseSettingUpdate('autoAcceptOptimizationResults', DEFAULT_CHAT_SETTINGS)).toEqual({
      autoAcceptOptimizationResults: true,
    })
    expect(
      parseSettingUpdate('autoAcceptOptimizationResults', {
        ...DEFAULT_CHAT_SETTINGS,
        autoAcceptOptimizationResults: true,
      })
    ).toEqual({
      autoAcceptOptimizationResults: false,
    })
  })

  it('shouldReadTheSavedValue', () => {
    expect(parseSettings({ autoAcceptOptimizationResults: true }).autoAcceptOptimizationResults).toBe(true)
    expect(parseSettings({})).not.toHaveProperty('autoAcceptOptimizationResults')
    expect(parseSettings({ autoAcceptOptimizationResults: 'yes' })).not.toHaveProperty('autoAcceptOptimizationResults')
  })

  it.each([
    [true, 'on · the edits of a finished optimization are written to the agent without a review'],
    [false, 'off · a finished optimization shows its edits, and you apply or leave each one'],
  ])('shouldExplainWhatItDoesWhenItIs%s', (autoAcceptOptimizationResults, text) => {
    expect(
      settingDescription({ ...DEFAULT_CHAT_SETTINGS, autoAcceptOptimizationResults }, 'autoAcceptOptimizationResults')
    ).toBe(text)
  })
})

describe('autoOptimize setting', () => {
  it('shouldDefaultToOffWithoutAKeyInThePlainSettings', () => {
    expect(DEFAULT_CHAT_SETTINGS).not.toHaveProperty('autoOptimize')
    expect(settingValue(DEFAULT_CHAT_SETTINGS, 'autoOptimize')).toBe(0)
  })

  it('shouldAppearInTheWorkspaceSectionAsAFieldForAWholeNumberOfTurns', () => {
    const definition = SETTING_DEFINITIONS.find(({ key }) => key === 'autoOptimize')

    expect(definition).toEqual({
      key: 'autoOptimize',
      label: 'Auto-optimize every N turns',
      section: 'Workspace',
      control: 'number',
      options: [],
      max: AUTO_OPTIMIZE_MAX_TURNS,
    })
    expect(AUTO_OPTIMIZE_MAX_TURNS).toBe(9999)
  })

  it('shouldTakeAnyWholeNumberOfTurnsUpToTheMaximum', () => {
    expect(parseSettingUpdate('autoOptimize=20', DEFAULT_CHAT_SETTINGS)).toEqual({ autoOptimize: 20 })
    expect(parseSettingUpdate('autoOptimize=7', DEFAULT_CHAT_SETTINGS)).toEqual({ autoOptimize: 7 })
    expect(parseSettingUpdate('autoOptimize=9999', DEFAULT_CHAT_SETTINGS)).toEqual({ autoOptimize: 9999 })
    expect(parseSettingUpdate('autoOptimize=0', { ...DEFAULT_CHAT_SETTINGS, autoOptimize: 20 })).toEqual({
      autoOptimize: 0,
    })
  })

  it.each([
    'autoOptimize',
    'autoOptimize=',
    'autoOptimize=true',
    'autoOptimize=7.5',
    'autoOptimize=-5',
    'autoOptimize=1e2',
    'autoOptimize= 20',
    'autoOptimize=10000',
  ])('shouldChangeNothingFor %s', (update) => {
    expect(parseSettingUpdate(update, DEFAULT_CHAT_SETTINGS)).toBeUndefined()
  })

  it('shouldReadTheSavedCadenceAndTakeAnythingElseAsOff', () => {
    expect(effective({ autoOptimize: 50 }).autoOptimize).toBe(50)
    expect(effective({}).autoOptimize).toBe(0)
    expect(effective({ autoOptimize: 7 }).autoOptimize).toBe(7)
    expect(effective({ autoOptimize: 7.5 }).autoOptimize).toBe(0)
    expect(effective({ autoOptimize: -5 }).autoOptimize).toBe(0)
    expect(effective({ autoOptimize: 10000 }).autoOptimize).toBe(0)
    expect(effective({ autoOptimize: '20' }).autoOptimize).toBe(0)
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

describe('settings', () => {
  it('shouldNotOfferAutofillForAgentQuestions', () => {
    expect(SETTING_DEFINITIONS.map(({ label }) => label)).not.toContain('Autofill agent questions')
  })

  it('shouldIgnoreAnAutofillValueSavedByAnEarlierVersion', () => {
    expect(parseSettings({ uiAutofill: true })).not.toHaveProperty('uiAutofill')
  })
})
