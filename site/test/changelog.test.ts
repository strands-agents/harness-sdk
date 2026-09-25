import { describe, it, expect } from 'vitest'
import { changelogEntrySchema, changelogFrontmatterSchema } from '../src/content.config'

describe('changelogEntrySchema', () => {
  it('parses a full entry', () => {
    const input = {
      type: 'feat',
      breaking: false,
      scope: 'model',
      areas: ['model'],
      title: 'plumb Gemini cache tokens',
      pr: 2287,
      prUrl: 'https://github.com/strands-agents/harness-sdk/pull/2287',
      commit: 'a1b2c3d',
      commitUrl: 'https://github.com/strands-agents/harness-sdk/commit/a1b2c3d',
      author: 'yatszhash',
    }
    // Assert the whole object so a dropped passthrough or flipped default fails.
    expect(changelogEntrySchema.parse(input)).toEqual(input)
  })

  it('applies defaults for sparse entries', () => {
    const entry = changelogEntrySchema.parse({ type: 'fix', title: 'handle null' })
    expect(entry).toEqual({
      type: 'fix',
      title: 'handle null',
      breaking: false,
      scope: null,
      areas: [],
      pr: null,
      prUrl: null,
      commit: null,
      commitUrl: null,
      author: null,
    })
  })

  it('rejects unknown type', () => {
    expect(() => changelogEntrySchema.parse({ type: 'wat', title: 'x' })).toThrow()
  })
})

describe('changelogFrontmatterSchema', () => {
  it('coerces a string date to a Date', () => {
    const fm = changelogFrontmatterSchema.parse({
      sdk: 'sdk',
      language: 'python',
      version: '1.42.0',
      tag: 'python/v1.42.0',
      date: '2026-06-01',
      releaseUrl: 'https://github.com/strands-agents/harness-sdk/releases/tag/python%2Fv1.42.0',
      packageUrl: 'https://pypi.org/project/strands-agents/1.42.0/',
      entries: [{ type: 'feat', title: 'add Limits' }],
    })
    expect(fm.date).toBeInstanceOf(Date) // string date is coerced
  })

  it('allows evals release without language', () => {
    const fm = changelogFrontmatterSchema.parse({
      sdk: 'evals',
      version: '0.2.1',
      tag: 'v0.2.1',
      date: '2026-05-29',
      releaseUrl: 'https://github.com/strands-agents/evals/releases/tag/v0.2.1',
      packageUrl: 'https://pypi.org/project/strands-agents-evals/0.2.1/',
      entries: [],
    })
    expect(fm.language).toBeUndefined()
  })

  it('rejects a harness release with no language', () => {
    expect(() =>
      changelogFrontmatterSchema.parse({
        sdk: 'sdk',
        version: '1.0.0',
        tag: 'v1.0.0',
        date: '2026-01-01',
        releaseUrl: 'https://github.com/strands-agents/harness-sdk/releases/tag/v1.0.0',
        packageUrl: 'https://pypi.org/project/strands-agents/1.0.0/',
        entries: [],
      })
    ).toThrow()
  })

  it('rejects an evals release that sets a language', () => {
    expect(() =>
      changelogFrontmatterSchema.parse({
        sdk: 'evals',
        language: 'typescript',
        version: '0.2.1',
        tag: 'v0.2.1',
        date: '2026-05-29',
        releaseUrl: 'https://github.com/strands-agents/evals/releases/tag/v0.2.1',
        packageUrl: 'https://pypi.org/project/strands-agents-evals/0.2.1/',
        entries: [],
      })
    ).toThrow()
  })
})

import { groupEntries, getAreaCounts, formatChangelogDate, escapeMarkdownInline } from '../src/util/changelog'

describe('escapeMarkdownInline (.md endpoint safety)', () => {
  it('escapes snake_case so it does not render as italics', () => {
    expect(escapeMarkdownInline('include tool executions in _extract_trace_level')).toBe(
      'include tool executions in \\_extract\\_trace\\_level'
    )
  })
  it('escapes brackets, backticks, and asterisks', () => {
    expect(escapeMarkdownInline('fix [x] and `y` and *z*')).toBe('fix \\[x\\] and \\`y\\` and \\*z\\*')
  })
  it('leaves plain text untouched', () => {
    expect(escapeMarkdownInline('add agent factory for isolating context')).toBe(
      'add agent factory for isolating context'
    )
  })
})

// compareVersionDesc ordering is covered in test/changelog/semver.test.ts
// (its canonical home, next to the module). Not duplicated here.
import type { ChangelogEntry } from '../src/content.config'

const mk = (over: Partial<ChangelogEntry>): ChangelogEntry => ({
  type: 'feat',
  breaking: false,
  scope: null,
  areas: [],
  title: 't',
  pr: null,
  prUrl: null,
  commit: null,
  commitUrl: null,
  author: null,
  ...over,
})

describe('groupEntries', () => {
  it('splits into features, fixes, other and keeps breaking in features', () => {
    const g = groupEntries([
      mk({ type: 'feat', title: 'a' }),
      mk({ type: 'breaking', title: 'b' }),
      mk({ type: 'fix', title: 'c' }),
      mk({ type: 'chore', title: 'd' }),
      mk({ type: 'docs', title: 'e' }),
    ])
    expect(g.features.map((e) => e.title)).toEqual(['b', 'a']) // breaking first
    expect(g.fixes.map((e) => e.title)).toEqual(['c'])
    expect(g.other.map((e) => e.title)).toEqual(['d', 'e'])
  })
})

describe('getAreaCounts', () => {
  it('counts entries per area, sorted desc', () => {
    const counts = getAreaCounts([mk({ areas: ['model'] }), mk({ areas: ['model', 'mcp'] }), mk({ areas: [] })])
    expect(counts).toEqual([
      { area: 'model', count: 2 },
      { area: 'mcp', count: 1 },
    ])
  })

  it('counts only the curated areas field — scopes are not folded in', () => {
    const counts = getAreaCounts([
      mk({ areas: ['model'], scope: 'model' }),
      mk({ areas: [], scope: 'tests' }), // raw scope must NOT become a facet
      mk({ areas: ['tool'], scope: null }),
    ])
    expect(counts).toEqual([
      { area: 'model', count: 1 },
      { area: 'tool', count: 1 },
    ])
  })
})

describe('formatChangelogDate', () => {
  it('formats as a short date', () => {
    expect(formatChangelogDate(new Date('2026-06-01T00:00:00Z'))).toMatch(/Jun 1, 2026/)
  })
})
