import { describe, expect, it } from 'vitest'
import { markdownTwinHref } from '../src/util/markdown-twin'

const docIds = new Set(['docs/user-guide/quickstart', 'docs/user-guide/box/intro'])
const sampleGuideRouteIds = new Set(['examples/python/first-agent'])

describe('markdownTwinHref', () => {
  it('links a docs page to its index.md twin', () => {
    const entry = { id: 'docs/user-guide/quickstart', data: {} }
    expect(markdownTwinHref(entry, docIds, sampleGuideRouteIds, '/')).toBe('/docs/user-guide/quickstart/index.md')
  })

  it('keeps a preview base path', () => {
    const entry = { id: 'docs/user-guide/quickstart', data: {} }
    expect(markdownTwinHref(entry, docIds, sampleGuideRouteIds, '/pr-12/')).toBe(
      '/pr-12/docs/user-guide/quickstart/index.md'
    )
  })

  it('links a generated sample guide', () => {
    const entry = { id: 'examples/python/first-agent', data: {} }
    expect(markdownTwinHref(entry, docIds, sampleGuideRouteIds, '/')).toBe('/examples/python/first-agent/index.md')
  })

  it('has no twin for imported docs in preview', () => {
    const entry = { id: 'docs/user-guide/box/intro', data: { externalDocs: { status: 'preview' } } }
    expect(markdownTwinHref(entry, docIds, sampleGuideRouteIds, '/')).toBeNull()
  })

  it('has no twin for pages outside the docs and sample guide collections', () => {
    const entry = { id: 'blog/hello-world', data: {} }
    expect(markdownTwinHref(entry, docIds, sampleGuideRouteIds, '/')).toBeNull()
  })
})
