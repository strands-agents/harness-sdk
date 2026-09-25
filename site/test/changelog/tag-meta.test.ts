import { describe, it, expect } from 'vitest'
import { tagToMeta, getPackageUrl } from '../../scripts/changelog/tag-meta'

describe('tag-meta', () => {
  it('harness python prefixed tag', () => {
    expect(tagToMeta('strands-agents/harness-sdk', 'python/v1.42.0')).toEqual({
      sdk: 'sdk',
      language: 'python',
      version: '1.42.0',
    })
  })

  it('harness typescript prefixed tag', () => {
    expect(tagToMeta('strands-agents/harness-sdk', 'typescript/v1.4.0')).toEqual({
      sdk: 'sdk',
      language: 'typescript',
      version: '1.4.0',
    })
  })

  it('harness bare v tag is pre-monorepo python', () => {
    expect(tagToMeta('strands-agents/harness-sdk', 'v1.9.1')).toEqual({
      sdk: 'sdk',
      language: 'python',
      version: '1.9.1',
    })
  })

  it('evals bare v tag is python-only (no language)', () => {
    expect(tagToMeta('strands-agents/evals', 'v0.2.1')).toEqual({
      sdk: 'evals',
      language: undefined,
      version: '0.2.1',
    })
  })

  it('evals python-prefixed tag also maps to evals python', () => {
    expect(tagToMeta('strands-agents/evals', 'python/v0.1.3')).toEqual({
      sdk: 'evals',
      language: undefined,
      version: '0.1.3',
    })
  })

  it('malformed typescript tag still parses', () => {
    expect(tagToMeta('strands-agents/harness-sdk', 'typescript/v.1.2.0')).toEqual({
      sdk: 'sdk',
      language: 'typescript',
      version: '1.2.0',
    })
  })

  it('python-wasm is skipped (null)', () => {
    expect(tagToMeta('strands-agents/harness-sdk', 'python-wasm/v0.0.1')).toBe(null)
  })

  it('archived sdk-typescript repo bare v tags map to harness/typescript', () => {
    expect(tagToMeta('strands-agents/sdk-typescript', 'v1.3.0')).toEqual({
      sdk: 'sdk',
      language: 'typescript',
      version: '1.3.0',
    })
    // rc tags parse too
    expect(tagToMeta('strands-agents/sdk-typescript', 'v1.0.0-rc.5')).toEqual({
      sdk: 'sdk',
      language: 'typescript',
      version: '1.0.0-rc.5',
    })
  })

  it('package urls', () => {
    expect(getPackageUrl('sdk', 'python', '1.42.0')).toBe('https://pypi.org/project/strands-agents/1.42.0/')
    expect(getPackageUrl('sdk', 'typescript', '1.4.0')).toBe(
      'https://www.npmjs.com/package/@strands-agents/sdk/v/1.4.0'
    )
    expect(getPackageUrl('evals', undefined, '0.2.1')).toBe('https://pypi.org/project/strands-agents-evals/0.2.1/')
  })
})
