import { describe, it, expect } from 'vitest'
import { renderMarkdown, mergePreserving } from '../../scripts/changelog/render-markdown'

describe('render-markdown', () => {
  const file = {
    sdk: 'sdk' as const,
    language: 'python' as const,
    version: '1.42.0',
    tag: 'python/v1.42.0',
    date: '2026-06-01',
    releaseUrl: 'https://github.com/strands-agents/harness-sdk/releases/tag/python%2Fv1.42.0',
    packageUrl: 'https://pypi.org/project/strands-agents/1.42.0/',
    entries: [
      {
        type: 'feat',
        breaking: false,
        scope: 'model',
        areas: ['model'],
        title: 'plumb cache tokens',
        pr: 2287,
        prUrl: 'https://github.com/strands-agents/sdk-python/pull/2287',
        commit: '155239d',
        commitUrl: 'https://github.com/strands-agents/sdk-python/commit/155239d',
        author: 'yatszhash',
      },
    ],
    newContributors: [],
  }

  it('renders valid frontmatter markdown', () => {
    const md = renderMarkdown(file)
    expect(md).toMatch(/^---\n/)
    expect(md).toMatch(/\nsdk: sdk\n/)
    expect(md).toMatch(/\nlanguage: python\n/)
    expect(md).toMatch(/\nversion: "1\.42\.0"\n/)
    expect(md).toMatch(/\ntag: python\/v1\.42\.0\n/)
    expect(md).toMatch(/type: feat/)
    expect(md).toMatch(/areas: \[model\]/)
    expect(md).toMatch(/title: "plumb cache tokens"/)
    expect(md).not.toMatch(/highlights:/) // none provided
  })

  it('evals omits language key', () => {
    const md = renderMarkdown({
      ...file,
      sdk: 'evals' as const,
      language: undefined,
      tag: 'v0.2.1',
      version: '0.2.1',
      releaseUrl: 'https://github.com/strands-agents/evals/releases/tag/v0.2.1',
      packageUrl: 'https://pypi.org/project/strands-agents-evals/0.2.1/',
    })
    expect(md).not.toMatch(/\nlanguage:/)
  })

  it('empty entries renders entries: []', () => {
    expect(renderMarkdown({ ...file, entries: [] })).toMatch(/\nentries: \[\]\n/)
  })

  it('quotes all-digit commit so YAML keeps it a string', () => {
    const md = renderMarkdown({
      ...file,
      entries: [{ ...file.entries[0], commit: '1122334', commitUrl: 'https://github.com/o/r/commit/1122334' }],
    })
    expect(md).toMatch(/commit: "1122334"/)
  })

  it('null pr/commit/author render as null', () => {
    const md = renderMarkdown({
      ...file,
      entries: [
        {
          type: 'feat',
          breaking: false,
          scope: null,
          areas: [],
          title: 'x',
          pr: null,
          prUrl: null,
          commit: null,
          commitUrl: null,
          author: null,
        },
      ],
    })
    expect(md).toMatch(/pr: null/)
    expect(md).toMatch(/commit: null/)
    expect(md).toMatch(/author: null/)
    expect(md).toMatch(/scope: null/)
  })

  it('quotes areas that contain YAML-significant chars', () => {
    const md = renderMarkdown({
      ...file,
      entries: [{ ...file.entries[0], areas: ['model', 'a,b', 'weird]bracket', 'has space'] }],
    })
    // commas/brackets/spaces inside a label must be quoted so the flow seq stays valid
    expect(md).toMatch(/areas: \[model, "a,b", "weird\]bracket", "has space"\]/)
  })

  it('quotes YAML reserved bool/null words in scope and areas', () => {
    const md = renderMarkdown({
      ...file,
      entries: [{ ...file.entries[0], scope: 'on', areas: ['yes', 'null', 'model'] }],
    })
    expect(md).toMatch(/scope: "on"/)
    expect(md).toMatch(/areas: \["yes", "null", model\]/)
  })

  it('escapes quotes and newlines in titles', () => {
    const md = renderMarkdown({
      ...file,
      entries: [{ ...file.entries[0], title: 'add "quoted" thing' }],
    })
    expect(md).toMatch(/title: "add \\"quoted\\" thing"/)
  })

  it('renders newContributors when present, omits when empty', () => {
    const md = renderMarkdown({
      ...file,
      newContributors: [
        { login: 'newdev', pr: 2700, prRepo: 'o/r' },
        { login: 'other-dev', pr: 2701, prRepo: 'o/r' },
      ],
    })
    expect(md).toMatch(/newContributors:\n  - \{ login: newdev, pr: 2700 \}\n  - \{ login: other-dev, pr: 2701 \}/)
    expect(renderMarkdown(file)).not.toMatch(/newContributors/)
  })

  it('mergePreserving keeps existing highlights + body, refreshes entries', () => {
    const existing = `---
sdk: sdk
language: python
version: "1.42.0"
tag: python/v1.42.0
date: 2026-06-01
releaseUrl: https://example/r
packageUrl: https://example/p
highlights: |
  Hand written summary.
entries: []
---

Some curated prose body.`
    const merged = mergePreserving(file, existing)
    expect(merged).toMatch(/highlights: \|/)
    expect(merged).toMatch(/Hand written summary\./)
    expect(merged).toMatch(/Some curated prose body\./)
    expect(merged).toMatch(/plumb cache tokens/) // entries refreshed from fresh file
  })

  it('mergePreserving with no existing file just renders fresh', () => {
    const merged = mergePreserving(file, null)
    expect(merged).toBe(renderMarkdown(file))
  })
})
