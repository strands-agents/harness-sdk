import { describe, expect, it } from 'vitest'

import {
  defaultSample,
  getSampleLanguageSwitchPath,
  getSamplePagePath,
  getSamplePagination,
} from '../src/util/sample-navigation'
import { sampleDetails } from '../src/util/sample-details'

describe('sample navigation', () => {
  it('switches to a matching language counterpart when one exists', () => {
    const pythonFirstAgent = sampleDetails.find(
      (sample) => sample.metadata.language.toLowerCase() === 'python' && sample.slug.endsWith('/first-agent')
    )
    if (!pythonFirstAgent) throw new Error('Expected the Python First Agent sample')

    expect(getSampleLanguageSwitchPath('/examples/', 'python')).toBe(getSamplePagePath(pythonFirstAgent))
    expect(getSampleLanguageSwitchPath(getSamplePagePath(pythonFirstAgent), 'typescript')).toBe('/examples/')
    expect(getSampleLanguageSwitchPath('/examples/', 'typescript')).toBeUndefined()
  })

  it('falls back to the first sample in a target language without a counterpart', () => {
    const pythonOnly =
      sampleDetails.find(
        (sample) =>
          sample.metadata.language.toLowerCase() === 'python' &&
          !sampleDetails.some(
            (candidate) =>
              candidate.metadata.language.toLowerCase() === 'typescript' &&
              candidate.slug.split('/').slice(1).join('/') === sample.slug.split('/').slice(1).join('/')
          )
      ) ?? sampleDetails.find((sample) => sample.metadata.language.toLowerCase() === 'python')
    const firstTypeScript = sampleDetails.find((sample) => sample.metadata.language.toLowerCase() === 'typescript')
    if (!pythonOnly || !firstTypeScript) throw new Error('Expected samples in both languages')

    expect(getSampleLanguageSwitchPath(getSamplePagePath(pythonOnly), 'typescript')).toBe(
      getSamplePagePath(firstTypeScript)
    )
  })

  it('keeps previous and next links within the selected language', () => {
    for (const sample of sampleDetails) {
      const pagination = getSamplePagination(sample)
      for (const link of [pagination.prev, pagination.next]) {
        if (link === false) continue
        const target = sampleDetails.find((candidate) => getSamplePagePath(candidate) === link.link)
        expect(target, `${sample.slug} -> ${link.link}`).toBeDefined()
        expect(target?.metadata.language.toLowerCase()).toBe(sample.metadata.language.toLowerCase())
      }
    }

    expect(getSamplePagination(defaultSample).prev).toBe(false)
  })
})
