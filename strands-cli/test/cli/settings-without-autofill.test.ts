import { describe, expect, it } from 'vitest'

import { parseSettings, SETTING_DEFINITIONS } from '../../src/config/settings.js'

describe('settings', () => {
  it('shouldNotOfferAutofillForAgentQuestions', () => {
    expect(SETTING_DEFINITIONS.map(({ label }) => label)).not.toContain('Autofill agent questions')
  })

  it('shouldIgnoreAnAutofillValueSavedByAnEarlierVersion', () => {
    expect(parseSettings({ uiAutofill: true })).not.toHaveProperty('uiAutofill')
  })
})
