import { describe, it, expect } from 'vitest'
import { classifyTitle, parseNewContributors } from '../../scripts/changelog/parse-release-body'

describe('parse-release-body', () => {
  // --- classifyTitle -----------------------------------------------------------

  it('classifies conventional-commit titles (type/scope/breaking)', () => {
    expect(classifyTitle('fix(tests): fix flaky tests')).toEqual({
      type: 'fix',
      scope: 'tests',
      breaking: false,
      title: 'fix flaky tests',
    })
    expect(classifyTitle('feat(gemini): plumb through cache tokens')).toEqual({
      type: 'feat',
      scope: 'gemini',
      breaking: false,
      title: 'plumb through cache tokens',
    })
    expect(classifyTitle('feat!: drop legacy run()')).toEqual({
      type: 'feat',
      scope: null,
      breaking: true,
      title: 'drop legacy run()',
    })
  })

  it('maps non-changelog conventional types (build/ci/style/revert) to other', () => {
    // KNOWN_TYPES is the changelog-visible subset; everything else collapses to 'other'.
    expect(classifyTitle('ci: bump runner').type).toBe('other')
    expect(classifyTitle('build(deps): bump uuid').type).toBe('other')
  })

  it('non-conventional title falls back to type other', () => {
    expect(classifyTitle('just did a thing')).toEqual({
      type: 'other',
      scope: null,
      breaking: false,
      title: 'just did a thing',
    })
  })

  it('strips the "_(shared with TS/Python)_" cross-SDK annotation from the title', () => {
    expect(classifyTitle('feat: add memory injection _(shared with TS)_').title).toBe('add memory injection')
  })

  // --- parseNewContributors ----------------------------------------------------

  const nc = `## What's Changed
* feat: real change by @dev in https://github.com/o/r/pull/1

## New Contributors
* @senthilkumarmohan made their first contribution in https://github.com/strands-agents/harness-sdk/pull/2623
* @ianholtz made their first contribution in https://github.com/strands-agents/harness-sdk/pull/2651

**Full Changelog**: https://github.com/o/r/compare/a...b`

  it('extracts structured logins + prs + prRepo', () => {
    expect(parseNewContributors(nc)).toEqual([
      { login: 'senthilkumarmohan', pr: 2623, prRepo: 'strands-agents/harness-sdk' },
      { login: 'ianholtz', pr: 2651, prRepo: 'strands-agents/harness-sdk' },
    ])
  })

  it('empty/undefined body yields no contributors', () => {
    expect(parseNewContributors('')).toEqual([])
    expect(parseNewContributors(null)).toEqual([])
  })

  it('captures bracket-suffixed bot logins (e.g. dependabot[bot])', () => {
    const body = '* @dependabot[bot] made their first contribution in https://github.com/o/r/pull/625'
    expect(parseNewContributors(body)).toEqual([{ login: 'dependabot[bot]', pr: 625, prRepo: 'o/r' }])
  })

  it('handles CRLF line endings (real GitHub bodies)', () => {
    const crlf = '## New Contributors\r\n* @dev made their first contribution in https://github.com/o/r/pull/7\r\n'
    expect(parseNewContributors(crlf)).toEqual([{ login: 'dev', pr: 7, prRepo: 'o/r' }])
  })

  it('ignores non-contributor bullets (regular "What\'s Changed" entries)', () => {
    // Only first-contribution lines are captured; entry bullets are derived from
    // the compare API, not this parser.
    expect(parseNewContributors('* feat: real change by @dev in https://github.com/o/r/pull/1')).toEqual([])
  })
})
