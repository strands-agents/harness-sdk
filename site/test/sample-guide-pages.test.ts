import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'
import { pathWithBase } from '../src/util/links'
import { isSampleGuidePath, sampleGuidePath, sortSampleGuides, type SampleGuideEntry } from '../src/util/sample-guides'

let guides: SampleGuideEntry[]

beforeAll(async () => {
  guides = sortSampleGuides(await getCollection('sampleGuides'))
})

function builtPage(guide?: SampleGuideEntry) {
  const relativePath = guide
    ? path.join('examples', guide.data.slug, 'index.html')
    : path.join('examples', 'index.html')
  return parse(readFileSync(new URL(`../dist/${relativePath}`, import.meta.url), 'utf8'))
}

function sidebarHrefs(page: ReturnType<typeof parse>): Set<string> {
  return new Set(page.querySelectorAll('.sidebar-content a').map((link) => link.getAttribute('href') ?? ''))
}

function sampleGuideHref(guide: SampleGuideEntry): string {
  return pathWithBase(sampleGuidePath(guide))
}

function expectPersistentSidebar(
  page: ReturnType<typeof parse>,
  guides: SampleGuideEntry[],
  currentGuide: SampleGuideEntry
): void {
  expect(page.querySelector('html[data-has-sidebar]')).not.toBeNull()
  expect(page.querySelector('.product-switcher__slug')?.textContent.trim()).toBe('/examples')
  expect(page.querySelector('.sidebar-content a[aria-current="page"]')?.getAttribute('href')).toBe(
    sampleGuideHref(currentGuide)
  )
  const hrefs = sidebarHrefs(page)
  for (const guide of guides) expect(hrefs.has(sampleGuideHref(guide)), guide.id).toBe(true)

  const mobileHrefs = new Set(
    page.querySelectorAll('.mobile-menu__pages a').map((link) => link.getAttribute('href') ?? '')
  )
  for (const guide of guides) expect(mobileHrefs.has(sampleGuideHref(guide)), guide.id).toBe(true)
}

describe('generated sample guide pages', () => {
  it('redirects /examples/ to the first guide for the stored language preference', () => {
    const defaultGuide =
      guides.find((guide) => guide.data.language === DEFAULT_LANGUAGE_LABEL.toLowerCase()) ?? guides[0]
    const pythonGuide = guides.find((guide) => guide.data.language === 'python') ?? defaultGuide
    const page = builtPage()
    const redirect = page.querySelector('[data-sample-guide-redirect]')

    expect(defaultGuide).toBeDefined()
    expect(pythonGuide).toBeDefined()
    expect(page.querySelector('#_top')?.textContent.trim()).toBe('Examples')
    expect(page.querySelector('html[data-has-sidebar]')).toBeNull()
    expect(redirect?.getAttribute('data-storage-key')).toBe(LANGUAGE_STORAGE_KEY)
    expect(redirect?.getAttribute('data-default-language')).toBe(DEFAULT_LANGUAGE_LABEL)
    expect(redirect?.getAttribute('data-default-target')).toBe(sampleGuideHref(defaultGuide!))
    expect(redirect?.getAttribute('data-python-target')).toBe(sampleGuideHref(pythonGuide!))
    expect(redirect?.querySelector('a')?.getAttribute('href')).toBe(sampleGuideHref(defaultGuide!))
  })

  it('renders every guide at a stable route with the same sample navigation', () => {
    for (const guide of guides) {
      const page = builtPage(guide)

      expect(page.querySelector('#_top')?.textContent.trim()).toBe(guide.data.title)
      expect(page.querySelectorAll('h1'), guide.id).toHaveLength(1)
      expect(page.querySelector('.sample-guide__source a')?.getAttribute('href')).toBe(guide.data.sourceUrl)
      expect(page.querySelector('.sample-guide__source code')).toBeNull()
      expectPersistentSidebar(page, guides, guide)
    }
  })

  it('renders fenced code with Expressive Code', () => {
    const guide = guides.find((entry) => entry.data.slug === 'typescript/first-agent')

    expect(guide).toBeDefined()
    expect(builtPage(guide).querySelector('.expressive-code')).not.toBeNull()
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
