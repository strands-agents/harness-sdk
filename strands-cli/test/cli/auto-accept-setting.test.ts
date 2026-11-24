import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CHAT_SETTINGS,
  parseSettings,
  parseSettingUpdate,
  settingDescription,
  SETTING_DEFINITIONS,
} from '../../src/config/settings.js'

describe('autoAcceptOptimizationResults setting', () => {
  it('shouldDefaultToOff', () => {
    expect(DEFAULT_CHAT_SETTINGS.autoAcceptOptimizationResults).toBe(false)
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
    expect(parseSettings({ autoOptimize: true })).toMatchObject({
      autoAcceptOptimizationResults: true,
      autoOptimize: 0,
    })
    expect(parseSettings({ autoOptimize: false })).toMatchObject({
      autoAcceptOptimizationResults: false,
      autoOptimize: 0,
    })
    expect(
      parseSettings({ autoOptimize: true, autoAcceptOptimizationResults: false }).autoAcceptOptimizationResults
    ).toBe(false)
    expect(parseSettings({ autoOptimize: 20 })).toMatchObject({
      autoAcceptOptimizationResults: false,
      autoOptimize: 20,
    })
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
    expect(parseSettings({}).autoAcceptOptimizationResults).toBe(false)
    expect(parseSettings({ autoAcceptOptimizationResults: 'yes' }).autoAcceptOptimizationResults).toBe(false)
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
