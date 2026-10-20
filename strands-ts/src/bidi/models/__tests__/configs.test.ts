import { describe, expect, it } from 'vitest'

import { mergeConfig } from '../configs.js'

describe('mergeConfig', () => {
  it.each([
    [
      'nested overrides',
      { audio: { voice: 'Kore', format: { rate: 24000, channels: 1 } } },
      { audio: { format: { rate: 48000 } }, temperature: 0.7 },
      { audio: { voice: 'Kore', format: { rate: 48000, channels: 1 } }, temperature: 0.7 },
    ],
    ['empty object preserves values', { audio: { voice: 'Kore' } }, { audio: {} }, { audio: { voice: 'Kore' } }],
    ['array replacement', { modalities: ['audio'] }, { modalities: ['text'] }, { modalities: ['text'] }],
    ['explicit null', { audio: { voice: 'Kore' } }, { audio: { voice: null } }, { audio: { voice: null } }],
    [
      'object replaces scalar',
      { speech: 'auto' },
      { speech: { language: 'en-US' } },
      { speech: { language: 'en-US' } },
    ],
    ['scalar replaces object', { speech: { language: 'en-US' } }, { speech: 'auto' }, { speech: 'auto' }],
    [
      'falsy overrides',
      { temperature: 0.7, enabled: true },
      { temperature: 0, enabled: false },
      { temperature: 0, enabled: false },
    ],
  ])('merges %s', (_name, config, overrides, expected) => {
    expect(mergeConfig(config, overrides)).toEqual(expected)
  })

  it('copies its inputs rather than aliasing them', () => {
    const config = { audio: { formats: ['pcm'] } }
    const overrides = { audio: { voices: ['Kore'] } }

    const merged = mergeConfig(config, overrides) as { audio: { formats: string[]; voices: string[] } }
    merged.audio.formats.push('wav')
    merged.audio.voices.push('Puck')

    expect(config).toEqual({ audio: { formats: ['pcm'] } })
    expect(overrides).toEqual({ audio: { voices: ['Kore'] } })
  })
})
