import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getCollection } from 'astro:content'
import { parse } from 'node-html-parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'
import { pathWithBase } from '../src/util/links'
import { languageLabel } from '../src/util/source-links'
import {
  isSampleGuidePath,
  sampleGuideLanguageFromPath,
  sampleGuidePath,
  sampleGuideSwitchPath,
  sortSampleGuides,
  type SampleGuideEntry,
} from '../src/util/sample-guides'

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

function builtMarkdownPage(guide: SampleGuideEntry): string {
  const relativePath = path.join('examples', guide.data.slug, 'index.md')
  return readFileSync(new URL(`../dist/${relativePath}`, import.meta.url), 'utf8')
}

function configuredPathWithBase(value: string): string {
  const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
  const normalizedValue = value.startsWith('/') ? value : `/${value}`
  return `${base}${normalizedValue}`
}

function sampleGuideHref(guide: SampleGuideEntry): string {
  return configuredPathWithBase(sampleGuidePath(guide))
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
  const languageGuides = guides.filter((guide) => guide.data.language === currentGuide.data.language)
  const expectedHrefs = languageGuides.map(sampleGuideHref)
  const expectedHrefSet = new Set(expectedHrefs)
  const orderedHrefs = page
    .querySelectorAll('.sidebar-content a')
    .map((link) => link.getAttribute('href') ?? '')
    .filter((href) => expectedHrefSet.has(href))
  expect(orderedHrefs).toEqual(expectedHrefs)

  const sidebarLanguages = page
    .querySelectorAll('.section-group[data-sidebar-lang]')
    .map((group) => group.getAttribute('data-sidebar-lang'))
  expect(sidebarLanguages).toEqual([currentGuide.data.language])

  const currentLanguage = currentGuide.data.language
  const currentLanguageLabel = currentLanguage === 'python' ? 'Python' : 'TypeScript'
  const otherLanguage = currentLanguage === 'python' ? 'typescript' : 'python'
  const otherLanguageLabel = otherLanguage === 'python' ? 'Python' : 'TypeScript'
  const switchTarget = sampleGuideSwitchPath(guides, currentGuide.data.slug, otherLanguage)
  for (const option of page.querySelectorAll(`language-toggle [data-lang="${currentLanguageLabel}"]`)) {
    expect(option.hasAttribute('disabled')).toBe(false)
    expect(option.getAttribute('data-switch-href')).toBeUndefined()
  }
  for (const option of page.querySelectorAll(`language-toggle [data-lang="${otherLanguageLabel}"]`)) {
    expect(option.hasAttribute('disabled')).toBe(false)
    expect(option.getAttribute('data-switch-href')).toBe(
      switchTarget ? configuredPathWithBase(switchTarget) : undefined
    )
  }

  const mobileHrefs = new Set(
    page.querySelectorAll('.mobile-menu__pages a').map((link) => link.getAttribute('href') ?? '')
  )
  for (const guide of languageGuides) expect(mobileHrefs.has(sampleGuideHref(guide)), guide.id).toBe(true)
  for (const guide of guides.filter((entry) => entry.data.language !== currentGuide.data.language)) {
    expect(mobileHrefs.has(sampleGuideHref(guide)), guide.id).toBe(false)
  }

  const currentIndex = languageGuides.findIndex((guide) => guide.id === currentGuide.id)
  const previous = languageGuides[currentIndex - 1]
  const next = languageGuides[currentIndex + 1]
  expect(page.querySelector('.pagination-links a[rel="prev"]')?.getAttribute('href')).toBe(
    previous ? sampleGuideHref(previous) : undefined
  )
  expect(page.querySelector('.pagination-links a[rel="next"]')?.getAttribute('href')).toBe(
    next ? sampleGuideHref(next) : undefined
  )
}

describe('generated sample guide pages', () => {
  it('renders the expected /examples/ landing state for the available sample source', () => {
    const page = builtPage()
    const redirect = page.querySelector('[data-sample-guide-redirect]')

    expect(page.querySelector('#_top')?.textContent.trim()).toBe('Examples')
    expect(page.querySelector('html[data-has-sidebar]')).toBeNull()

    if (guides.length === 0) {
      expect(redirect).toBeNull()
      expect(page.textContent).toContain('Sample guides are not available in this local build.')
      expect(page.textContent).toContain('SAMPLES_SOURCE_DIR')
      return
    }

    const defaultGuide =
      guides.find((guide) => guide.data.language === DEFAULT_LANGUAGE_LABEL.toLowerCase()) ?? guides[0]
    const pythonGuide = guides.find((guide) => guide.data.language === 'python') ?? defaultGuide

    expect(defaultGuide).toBeDefined()
    expect(pythonGuide).toBeDefined()
    expect(redirect?.getAttribute('data-storage-key')).toBe(LANGUAGE_STORAGE_KEY)
    expect(redirect?.getAttribute('data-default-language')).toBe(DEFAULT_LANGUAGE_LABEL)
    expect(redirect?.getAttribute('data-default-target')).toBe(sampleGuideHref(defaultGuide!))
    expect(redirect?.getAttribute('data-python-target')).toBe(sampleGuideHref(pythonGuide!))
    expect(redirect?.querySelector('a')?.getAttribute('href')).toBe(sampleGuideHref(defaultGuide!))
  })

  it('renders every guide at a stable route with language-scoped sample navigation', () => {
    for (const guide of guides) {
      const page = builtPage(guide)

      expect(page.querySelector('#_top')?.textContent.trim()).toBe(guide.data.title)
      expect(page.querySelectorAll('h1'), guide.id).toHaveLength(1)
      expect(page.querySelector('.sample-guide__source a')?.getAttribute('href')).toBe(guide.data.sourceUrl)
      expect(page.querySelector('.sample-guide__source code')).toBeNull()
      expect(page.querySelector('.sl-markdown-content > p')?.classList.contains('sample-guide__source')).toBe(true)
      expectPersistentSidebar(page, guides, guide)

      const markdownHref = page.querySelector('link[rel="alternate"][type="text/markdown"]')?.getAttribute('href')
      expect(markdownHref).toBe(configuredPathWithBase(`${sampleGuidePath(guide)}index.md`))

      const structuredData = JSON.parse(page.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')
      const breadcrumbs = structuredData['@graph']?.find(
        (item: { '@type'?: string }) => item['@type'] === 'BreadcrumbList'
      )
      expect(breadcrumbs?.itemListElement).toHaveLength(2)
      expect(breadcrumbs?.itemListElement[0]?.name).toBe('Examples')
      expect(breadcrumbs?.itemListElement[0]?.item).toMatch(/\/examples\/$/)
      expect(breadcrumbs?.itemListElement[1]?.name).toBe(guide.data.title)
      expect(breadcrumbs?.itemListElement[1]?.item).toBeUndefined()
    }
  })

  it('publishes every guide on the machine-readable documentation surfaces', () => {
    const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')
    const llmsFull = readFileSync(new URL('../dist/llms-full.txt', import.meta.url), 'utf8')

    for (const guide of guides) {
      const rawMarkdown = builtMarkdownPage(guide)
      const sourcePath = configuredPathWithBase(`/examples/${guide.data.slug}/index.md`)
      const label = `${guide.data.title} (${languageLabel(guide.data.language)})`

      expect(rawMarkdown.trim(), guide.id).not.toBe('')
      expect(rawMarkdown, guide.id).toContain('## Upstream source')
      expect(rawMarkdown, guide.id).toContain(guide.data.sourceUrl)
      expect(llms, guide.id).toContain(`[${label}](`)
      expect(llms, guide.id).toContain(sourcePath)
      expect(llmsFull, guide.id).toContain(`## ${label}`)
      expect(llmsFull, guide.id).toContain(guide.data.sourceUrl)
      expect(llmsFull, guide.id).toContain(`Markdown: `)
      expect(llmsFull, guide.id).toContain(sourcePath)
    }
  })

  it('renders fenced code with Expressive Code', () => {
    const guide = guides.find((entry) => entry.body?.includes('```'))

    if (!guide) {
      expect(guides).toHaveLength(0)
      return
    }

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

describe('sampleGuideLanguageFromPath', () => {
  it('returns the route language only for generated sample guide paths', () => {
    expect(sampleGuideLanguageFromPath(pathWithBase('/examples/python/first-agent/'))).toBe('python')
    expect(sampleGuideLanguageFromPath(pathWithBase('/examples/typescript/first-agent/'))).toBe('typescript')
    expect(sampleGuideLanguageFromPath(pathWithBase('/examples/'))).toBeUndefined()
    expect(sampleGuideLanguageFromPath(pathWithBase('/docs/examples/python/first-agent/'))).toBeUndefined()
  })
})

describe('sampleGuideSwitchPath', () => {
  const guide = (slug: string, language: string, order: number): SampleGuideEntry =>
    ({
      id: slug,
      collection: 'sampleGuides',
      data: {
        title: slug,
        description: `${slug} description`,
        slug,
        language,
        category: 'learn',
        categoryLabel: 'Learn',
        sourceUrl: `https://github.com/strands-agents/samples/tree/commit/${slug}`,
        order,
      },
    }) as SampleGuideEntry

  it('prefers an exact cross-language counterpart', () => {
    const entries = [
      guide('python/first-agent', 'python', 0),
      guide('typescript/fallback', 'typescript', 1),
      guide('typescript/first-agent', 'typescript', 2),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/first-agent', 'typescript')).toBe('/examples/typescript/first-agent/')
  })

  it('falls back to the first ordered guide in the target language', () => {
    const entries = [
      guide('python/python-only', 'python', 0),
      guide('typescript/second', 'typescript', 2),
      guide('typescript/first', 'typescript', 1),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/python-only', 'typescript')).toBe('/examples/typescript/first/')
  })
})
