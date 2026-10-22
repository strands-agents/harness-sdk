import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { describe, expect, it } from 'vitest'
import {
  findDefaultSampleGuide,
  isSampleGuidePath,
  sampleGuideHref,
  sampleSourceUrl,
  sortSampleGuides,
  type SampleGuideEntry,
} from '../src/util/sample-guides'

function builtPage(guide?: SampleGuideEntry) {
  const relativePath = guide
    ? path.join('examples', guide.data.slug, 'index.html')
    : path.join('examples', 'index.html')
  return parse(readFileSync(new URL(`../dist/${relativePath}`, import.meta.url), 'utf8'))
}

function sidebarHrefs(page: ReturnType<typeof parse>): Set<string> {
  return new Set(page.querySelectorAll('.sidebar-content a').map((link) => link.getAttribute('href') ?? ''))
}

function expectPersistentSidebar(
  page: ReturnType<typeof parse>,
  guides: SampleGuideEntry[],
  defaultGuide: SampleGuideEntry,
  currentGuide: SampleGuideEntry
): void {
  expect(page.querySelector('html[data-has-sidebar]')).not.toBeNull()
  expect(page.querySelector('.product-switcher__slug')?.textContent.trim()).toBe('/examples')
  expect(page.querySelector('.sidebar-content a[aria-current="page"]')?.getAttribute('href')).toBe(
    sampleGuideHref(currentGuide, defaultGuide)
  )
  const hrefs = sidebarHrefs(page)
  for (const guide of guides) expect(hrefs.has(sampleGuideHref(guide, defaultGuide)), guide.id).toBe(true)

  const mobileHrefs = new Set(
    page.querySelectorAll('.mobile-menu__pages a').map((link) => link.getAttribute('href') ?? '')
  )
  for (const guide of guides) expect(mobileHrefs.has(sampleGuideHref(guide, defaultGuide)), guide.id).toBe(true)
}

describe('generated sample guide pages', () => {
  it('renders the default guide as native documentation at /examples/', async () => {
    const guides = sortSampleGuides(await getCollection('sampleGuides'))
    const defaultGuide = findDefaultSampleGuide(guides)
    const page = builtPage()

    expect(page.querySelector('#_top')?.textContent.trim()).toBe(defaultGuide.data.title)
    expect(page.querySelectorAll('h1')).toHaveLength(1)
    expect(page.querySelector('.sample-guide__source a')?.getAttribute('href')).toBe(sampleSourceUrl(defaultGuide))
    expect(page.querySelector('.sample-guide__source code')).toBeNull()
    expect(page.querySelector('.expressive-code')).not.toBeNull()
    expectPersistentSidebar(page, guides, defaultGuide, defaultGuide)
  })

  it('keeps the same sample navigation on generated detail routes', async () => {
    const guides = sortSampleGuides(await getCollection('sampleGuides'))
    const defaultGuide = findDefaultSampleGuide(guides)
    const guide = guides.find((entry) => entry.id !== defaultGuide.id)
    expect(guide).toBeDefined()

    const page = builtPage(guide)
    expect(page.querySelector('#_top')?.textContent.trim()).toBe(guide!.data.title)
    expectPersistentSidebar(page, guides, defaultGuide, guide!)
  })

  it('uses the page title as the only H1 on every generated guide', async () => {
    const guides = sortSampleGuides(await getCollection('sampleGuides'))
    const defaultGuide = findDefaultSampleGuide(guides)

    for (const guide of guides) {
      const page = builtPage(guide.id === defaultGuide.id ? undefined : guide)
      expect(page.querySelectorAll('h1'), guide.id).toHaveLength(1)
    }
  })
})

describe('isSampleGuidePath', () => {
  it('matches only the examples root and its descendants', () => {
    expect(isSampleGuidePath('/examples')).toBe(true)
    expect(isSampleGuidePath('/examples/')).toBe(true)
    expect(isSampleGuidePath('/examples/typescript/first-agent/')).toBe(true)
    expect(isSampleGuidePath('/docs/examples/')).toBe(false)
    expect(isSampleGuidePath('/examples-archive/')).toBe(false)
  })
})
