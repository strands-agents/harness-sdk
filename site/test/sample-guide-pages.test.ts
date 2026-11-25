import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getCollection } from 'astro:content'
import { JSDOM } from 'jsdom'
import { parse } from 'node-html-parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'
import { pathWithBase } from '../src/util/links'
import { languageLabel } from '../src/util/source-links'
import {
  buildSampleGuideSidebar,
  groupSampleGuideCategories,
  groupSampleGuideFamilies,
  isSampleGuidePath,
  sampleGuideLanguageFromPath,
  sampleGuidePath,
  sampleGuideSwitchPath,
  sortSampleGuides,
  type SampleGuideEntry,
} from '../src/util/sample-guides'

let guides: SampleGuideEntry[]

interface GuideFixtureOptions {
  catalogMode?: 'legacy' | 'curated'
  family?: string
  category?: string
  categoryLabel?: string
  collection?: { id: string; label: string; description?: string; order: number }
}

function guideFixture(
  slug: string,
  language: 'python' | 'typescript',
  order: number,
  options: GuideFixtureOptions = {}
): SampleGuideEntry {
  const catalogMode = options.catalogMode ?? 'curated'
  return {
    id: slug,
    collection: 'sampleGuides',
    data: {
      catalogMode,
      title: slug,
      description: `${slug} description`,
      slug,
      language,
      category: options.category ?? 'learn',
      categoryLabel: options.categoryLabel ?? 'Learn',
      collection: options.collection,
      docs: [],
      family: options.family,
      sourceUrl: `https://github.com/strands-agents/samples/tree/commit/${slug}`,
      order,
    },
  } as SampleGuideEntry
}

beforeAll(async () => {
  guides = sortSampleGuides(await getCollection('sampleGuides'))
})

function builtPageHtml(guide?: SampleGuideEntry): string {
  const relativePath = guide
    ? path.join('examples', guide.data.slug, 'index.html')
    : path.join('examples', 'index.html')
  return readFileSync(new URL(`../dist/${relativePath}`, import.meta.url), 'utf8')
}

function builtPage(guide?: SampleGuideEntry) {
  return parse(builtPageHtml(guide))
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

function inlineScript(html: string, marker: string): string {
  const document = new JSDOM(html).window.document
  const script =
    [...document.querySelectorAll<HTMLScriptElement>('script')].find((script) => script.textContent.includes(marker))
      ?.textContent ?? ''
  if (!script) throw new Error(`Missing inline script containing ${marker}`)
  return script
}

function loadCatalog(preference?: string): JSDOM['window'] {
  const html = builtPageHtml()
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://example.test/examples/',
  })
  if (preference) dom.window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
  const scripts = [...dom.window.document.querySelectorAll<HTMLScriptElement>('script')].filter((script) =>
    ['SAMPLE_GUIDE_LANGUAGE', '__strandsLanguageToggleInit', '__strandsSampleCatalogInit'].some((marker) =>
      script.textContent.includes(marker)
    )
  )
  for (const script of scripts) dom.window.eval(script.textContent)
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
  return dom.window
}

function loadGuideLanguageToggle(guide: SampleGuideEntry, preference: string): JSDOM['window'] {
  const html = builtPageHtml(guide)
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `https://example.test${sampleGuidePath(guide)}`,
  })
  dom.window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
  dom.window.eval(inlineScript(html, '__strandsLanguageToggleInit'))
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
  return dom.window
}

function sidebarGuidesForLanguage(
  guides: SampleGuideEntry[],
  language: SampleGuideEntry['data']['language']
): SampleGuideEntry[] {
  return groupSampleGuideCategories(guides.filter((guide) => guide.data.language === language)).flatMap((category) =>
    category.families.flatMap((family) => family.guides)
  )
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
  const sidebarGuides = sidebarGuidesForLanguage(guides, currentGuide.data.language)
  const expectedHrefs = sidebarGuides.map(sampleGuideHref)
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
  expect(page.querySelectorAll('.section-group[data-sidebar-lang] details')).toHaveLength(0)

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
    expect(option.hasAttribute('disabled')).toBe(switchTarget === undefined)
    expect(option.getAttribute('data-switch-href')).toBe(
      switchTarget ? configuredPathWithBase(switchTarget) : undefined
    )
  }

  const mobileHrefs = new Set(
    page.querySelectorAll('.mobile-menu__pages a').map((link) => link.getAttribute('href') ?? '')
  )
  for (const guide of sidebarGuides) expect(mobileHrefs.has(sampleGuideHref(guide)), guide.id).toBe(true)
  for (const guide of guides.filter((entry) => !sidebarGuides.includes(entry))) {
    expect(mobileHrefs.has(sampleGuideHref(guide)), guide.id).toBe(false)
  }

  const paginationHrefs = [configuredPathWithBase('/examples/'), ...expectedHrefs]
  const currentIndex = paginationHrefs.indexOf(sampleGuideHref(currentGuide))
  const previous = paginationHrefs[currentIndex - 1]
  const next = paginationHrefs[currentIndex + 1]
  expect(page.querySelector('.pagination-links a[rel="prev"]')?.getAttribute('href')).toBe(previous)
  expect(page.querySelector('.pagination-links a[rel="next"]')?.getAttribute('href')).toBe(next)
}

describe('generated sample guide pages', () => {
  it('renders the expected /examples/ landing state for the available sample source', () => {
    const page = builtPage()

    expect(page.querySelector('#_top')?.textContent.trim()).toBe('Examples')

    if (guides.length === 0) {
      expect(page.querySelector('html[data-has-sidebar]')).toBeNull()
      expect(page.querySelector('[data-pagefind-body]')).not.toBeNull()
      expect(page.textContent).toContain('Sample guides are not available in this local build.')
      expect(page.textContent).toContain('SAMPLES_SOURCE_DIR')
      return
    }

    if (guides[0]?.data.catalogMode === 'legacy') {
      expect(page.querySelector('html[data-has-sidebar]')).toBeNull()
      const redirect = page.querySelector('[data-sample-guide-redirect]')
      const defaultGuide =
        guides.find((guide) => guide.data.language === DEFAULT_LANGUAGE_LABEL.toLowerCase()) ?? guides[0]!
      const pythonGuide = guides.find((guide) => guide.data.language === 'python')
      const defaultTarget = sampleGuideHref(defaultGuide)
      const pythonTarget = pythonGuide ? sampleGuideHref(pythonGuide) : defaultTarget

      expect(page.querySelector('[data-pagefind-body]')).toBeNull()
      expect(redirect).not.toBeNull()
      expect(redirect?.getAttribute('data-storage-key')).toBe(LANGUAGE_STORAGE_KEY)
      expect(redirect?.getAttribute('data-default-language')).toBe(DEFAULT_LANGUAGE_LABEL)
      expect(redirect?.getAttribute('data-default-target')).toBe(defaultTarget)
      expect(redirect?.getAttribute('data-python-target')).toBe(pythonTarget)
      expect(redirect?.querySelector('a')?.getAttribute('href')).toBe(defaultTarget)
      expect(page.querySelectorAll('.sl-link-card')).toHaveLength(0)
      return
    }

    expect(page.querySelector('[data-pagefind-body]')).not.toBeNull()
    expect(page.querySelector('html[data-has-sidebar]')).not.toBeNull()
    expect(page.querySelector('.product-switcher__slug')?.textContent.trim()).toBe('/examples')
    expect(page.querySelector('.sample-catalog__intro')?.textContent.trim()).toBe(
      `Showing ${DEFAULT_LANGUAGE_LABEL} examples, organized by what you want to learn or build.`
    )

    const landingSidebar = buildSampleGuideSidebar(guides)
    const sidebarLanguages = page
      .querySelectorAll('.section-group[data-sidebar-lang]')
      .map((group) => group.getAttribute('data-sidebar-lang'))
    expect(sidebarLanguages).toEqual(
      landingSidebar.map((group) => (group.label === 'Python' ? 'python' : 'typescript'))
    )
    expect(page.querySelectorAll('.section-group[data-sidebar-lang] details')).toHaveLength(0)
    for (const group of landingSidebar) {
      const language = group.label === 'Python' ? 'python' : 'typescript'
      const sidebarGroup = page.querySelector(`.section-group[data-sidebar-lang="${language}"]`)
      const expectedHrefs = [
        configuredPathWithBase('/examples/'),
        ...sidebarGuidesForLanguage(guides, language).map(sampleGuideHref),
      ]
      expect(sidebarGroup?.querySelectorAll('a').map((link) => link.getAttribute('href'))).toEqual(expectedHrefs)
    }

    const catalogSections = groupSampleGuideCategories(guides)
    expect(
      page
        .querySelectorAll('section[data-sample-category]')
        .map((section) => section.getAttribute('data-sample-category'))
    ).toEqual(catalogSections.map((section) => section.key))

    for (const section of catalogSections) {
      const renderedSection = page.querySelector(`section[data-sample-category="${section.key}"]`)
      expect(renderedSection?.querySelector('h2')?.getAttribute('id'), section.key).toBe(
        `sample-category-${section.key}`
      )
      expect(renderedSection?.querySelector('h2')?.textContent.trim(), section.key).toBe(section.label)
      if (section.description) {
        expect(renderedSection?.querySelector(':scope > p')?.textContent.trim(), section.key).toBe(section.description)
      }

      expect(
        renderedSection
          ?.querySelectorAll('.sl-link-card[data-sample-family]')
          .map((card) => card.getAttribute('data-sample-family'))
      ).toEqual(section.families.flatMap((family) => family.guides.map(() => family.key)))

      for (const family of section.families) {
        for (const guide of family.guides) {
          const card = renderedSection?.querySelector(
            `.sl-link-card[data-sample-family="${family.key}"][data-sample-language="${guide.data.language}"]`
          )
          expect(card?.querySelector('.sample-link-card__title')?.getAttribute('href'), guide.id).toBe(
            sampleGuideHref(guide)
          )
          expect(card?.querySelector('.sample-link-card__title')?.textContent.trim(), guide.id).toBe(guide.data.title)
          expect(card?.querySelector('.sample-link-card__description')?.textContent.trim(), guide.id).toBe(
            guide.data.description
          )
          expect(card?.querySelector('.sample-link-card__language')?.textContent.trim(), guide.id).toBe(
            languageLabel(guide.data.language)
          )
          expect(card?.hasAttribute('hidden'), guide.id).toBe(
            guide.data.language !== DEFAULT_LANGUAGE_LABEL.toLowerCase()
          )
        }
      }
    }
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
      expect(page.querySelector('[data-pagefind-body]')).not.toBeNull()
      expect(page.querySelector('.sample-guide__metadata')).toBeNull()

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

  it('publishes every route as Markdown and exposes every curated guide on discovery surfaces', () => {
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

  it('publishes exactly the generated guide routes in the sitemap', () => {
    const sitemap = readFileSync(new URL('../dist/sitemap-0.xml', import.meta.url), 'utf8')
    const exampleRoot = configuredPathWithBase('/examples/')
    const sitemapGuidePaths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => new URL(match[1]!).pathname)
      .filter((pathname) => pathname.startsWith(exampleRoot) && pathname !== exampleRoot)
      .sort()

    expect(sitemapGuidePaths).toEqual(guides.map(sampleGuideHref).sort())
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

describe('sample catalog language interactions', () => {
  it('shows only the selected language and hides empty catalog sections', ({ skip }) => {
    if (guides[0]?.data.catalogMode !== 'curated') skip('requires a curated sample catalog')

    const window = loadCatalog('Python')
    const cards = [...window.document.querySelectorAll<HTMLElement>('[data-sample-language]')]
    const sections = [...window.document.querySelectorAll<HTMLElement>('[data-sample-category]')]

    function expectLanguage(label: string, language: 'python' | 'typescript'): void {
      const visibleCards = cards.filter((card) => !card.hidden)
      expect(visibleCards).toHaveLength(guides.filter((guide) => guide.data.language === language).length)
      for (const card of visibleCards) {
        expect(card.dataset.sampleLanguage).toBe(language)
        expect(card.querySelector('.sample-link-card__title')?.getAttribute('href')).toContain(`/examples/${language}/`)
        expect(card.querySelector('.sample-link-card__language')?.textContent).toBe(label)
      }
      expect(window.document.querySelector('[data-sample-catalog-status]')?.textContent).toContain(
        `Showing ${label} examples`
      )
    }

    expectLanguage('Python', 'python')

    window.dispatchEvent(new window.CustomEvent('lang-change', { detail: 'Rust' }))
    expect(window.document.documentElement.dataset.langPref).toBe('rust')
    expect(cards.every((card) => card.hidden)).toBe(true)
    expect(sections.every((section) => section.hidden)).toBe(true)
    expect(window.document.querySelector('[data-sample-catalog-status]')?.textContent).toBe(
      'No Rust examples are available yet.'
    )

    const sectionIds = new Set(sections.map((section) => section.querySelector('h2')?.id))
    const tocEntries = [
      ...window.document.querySelectorAll<HTMLElement>('starlight-toc a[href], mobile-starlight-toc a[href]'),
    ]
      .filter((link) => sectionIds.has(link.getAttribute('href')?.replace(/^.*#/, '')))
      .map((link) => ({
        sectionId: link.getAttribute('href')?.replace(/^.*#/, ''),
        item: link.closest<HTMLElement>('li'),
      }))
      .filter((entry): entry is { sectionId: string; item: HTMLElement } => Boolean(entry.sectionId && entry.item))
    expect(tocEntries.length).toBeGreaterThan(0)
    expect(tocEntries.every(({ item }) => item.hidden)).toBe(true)

    window.dispatchEvent(new window.CustomEvent('lang-change', { detail: 'TypeScript' }))
    expectLanguage('TypeScript', 'typescript')
    expect(sections.some((section) => !section.hidden)).toBe(true)
    for (const { sectionId, item } of tocEntries) {
      expect(item.hidden).toBe(window.document.getElementById(sectionId)?.closest('section')?.hidden)
    }
  })
})

describe('sample guide language preference', () => {
  it('renders the route language without persisting it until the selector is used', ({ skip }) => {
    const guide = guides.find((entry) => entry.data.language === 'typescript')
    if (!guide) skip('requires a TypeScript sample guide')

    const window = loadGuideLanguageToggle(guide, 'Python')
    const typeScriptOptions = [
      ...window.document.querySelectorAll<HTMLButtonElement>('language-toggle [data-lang="TypeScript"]'),
    ]

    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('Python')
    expect(typeScriptOptions.every((option) => option.getAttribute('aria-checked') === 'true')).toBe(true)

    typeScriptOptions[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('TypeScript')
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
  it('switches only between guides with the same explicit family', () => {
    const entries = [
      guideFixture('python/first-agent', 'python', 0, { family: 'first-agent' }),
      guideFixture('typescript/fallback', 'typescript', 1),
      guideFixture('typescript/renamed-agent', 'typescript', 2, { family: 'first-agent' }),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/first-agent', 'typescript')).toBe(
      '/examples/typescript/renamed-agent/'
    )
  })

  it('does not guess a counterpart by slug or fall back to another guide', () => {
    const entries = [
      guideFixture('python/python-only', 'python', 0),
      guideFixture('typescript/python-only', 'typescript', 1),
      guideFixture('typescript/fallback', 'typescript', 2),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/python-only', 'typescript')).toBeUndefined()
  })

  it('preserves exact counterpart switching for legacy catalogs', () => {
    const entries = [
      guideFixture('python/first-agent', 'python', 0, { catalogMode: 'legacy' }),
      guideFixture('typescript/fallback', 'typescript', 1, { catalogMode: 'legacy' }),
      guideFixture('typescript/first-agent', 'typescript', 2, { catalogMode: 'legacy' }),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/first-agent', 'typescript')).toBe('/examples/typescript/first-agent/')
  })

  it('preserves ordered-language fallback switching for legacy catalogs', () => {
    const entries = [
      guideFixture('python/python-only', 'python', 0, { catalogMode: 'legacy' }),
      guideFixture('typescript/second', 'typescript', 2, { catalogMode: 'legacy' }),
      guideFixture('typescript/first', 'typescript', 1, { catalogMode: 'legacy' }),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/python-only', 'typescript')).toBe('/examples/typescript/first/')
  })
})

describe('groupSampleGuideFamilies', () => {
  it('groups language variants into one editorial family', () => {
    const entries = [
      guideFixture('python/dynamic-ui', 'python', 0, { family: 'dynamic-ui' }),
      guideFixture('typescript/dynamic-ui', 'typescript', 1, { family: 'dynamic-ui' }),
      guideFixture('python/standalone', 'python', 2),
    ]

    const families = groupSampleGuideFamilies(entries)

    expect(
      families.map((family) => ({
        key: family.key,
        primary: family.primary.data.slug,
        guides: family.guides.map((guide) => guide.data.slug),
      }))
    ).toEqual([
      {
        key: 'dynamic-ui',
        primary: 'python/dynamic-ui',
        guides: ['python/dynamic-ui', 'typescript/dynamic-ui'],
      },
      {
        key: 'python/standalone',
        primary: 'python/standalone',
        guides: ['python/standalone'],
      },
    ])
  })
})

describe('groupSampleGuideCategories', () => {
  it('groups editorial families by their manifest category and preserves manifest ordering and copy', () => {
    const userExperiences = {
      id: 'user-experiences',
      label: 'User experiences',
      description: 'Build interactive agent interfaces and human approval flows.',
      order: 0,
    }
    const migrate = {
      id: 'migrate',
      label: 'Migrate',
      description: 'Move an existing agent application to Strands.',
      order: 1,
    }
    const entries = [
      guideFixture('python/langgraph', 'python', 0, {
        family: 'langgraph',
        collection: migrate,
      }),
      guideFixture('python/dynamic-ui', 'python', 1, {
        family: 'dynamic-ui',
        collection: userExperiences,
      }),
      guideFixture('typescript/dynamic-ui', 'typescript', 2, {
        family: 'dynamic-ui',
        collection: userExperiences,
      }),
      guideFixture('python/ungrouped', 'python', 3, {
        category: 'technical-use-cases',
        categoryLabel: 'Technical use cases',
      }),
    ]

    expect(
      groupSampleGuideCategories(entries).map((category) => ({
        key: category.key,
        label: category.label,
        description: category.description,
        families: category.families.map((family) => ({
          key: family.key,
          guides: family.guides.map((guide) => guide.data.slug),
        })),
      }))
    ).toEqual([
      {
        key: 'user-experiences',
        label: 'User experiences',
        description: 'Build interactive agent interfaces and human approval flows.',
        families: [
          {
            key: 'dynamic-ui',
            guides: ['python/dynamic-ui', 'typescript/dynamic-ui'],
          },
        ],
      },
      {
        key: 'migrate',
        label: 'Migrate',
        description: 'Move an existing agent application to Strands.',
        families: [
          {
            key: 'langgraph',
            guides: ['python/langgraph'],
          },
        ],
      },
      {
        key: 'technical-use-cases',
        label: 'Technical use cases',
        description: undefined,
        families: [
          {
            key: 'python/ungrouped',
            guides: ['python/ungrouped'],
          },
        ],
      },
    ])
  })
})

describe('buildSampleGuideSidebar', () => {
  const learn = { id: 'learn', label: 'Learn', order: 0 }
  const migrate = { id: 'migrate', label: 'Migrate', order: 1 }
  const entries = [
    guideFixture('typescript/learn', 'typescript', 0, { collection: learn }),
    guideFixture('python/learn', 'python', 1, { collection: learn }),
    guideFixture('typescript/migrate', 'typescript', 2, { collection: migrate }),
    guideFixture('python/migrate', 'python', 3, { collection: migrate }),
  ]
  const expectedTypeScript = {
    label: 'TypeScript',
    collapsed: false,
    items: [
      { label: 'Overview', link: '/examples/' },
      { label: 'typescript/learn', link: '/examples/typescript/learn/' },
      { label: 'typescript/migrate', link: '/examples/typescript/migrate/' },
    ],
  }
  const expectedPython = {
    label: 'Python',
    collapsed: false,
    items: [
      { label: 'Overview', link: '/examples/' },
      { label: 'python/learn', link: '/examples/python/learn/' },
      { label: 'python/migrate', link: '/examples/python/migrate/' },
    ],
  }

  it('builds the landing sidebar in preferred language order with every published guide', () => {
    expect(buildSampleGuideSidebar(entries)).toEqual([expectedTypeScript, expectedPython])
  })

  it('scopes a guide sidebar to its language', () => {
    expect(buildSampleGuideSidebar(entries, entries[3])).toEqual([expectedPython])
  })

  it('preserves category groups and omits Overview for legacy guide sidebars', () => {
    const legacyEntries = [
      guideFixture('python/first-agent', 'python', 0, {
        catalogMode: 'legacy',
        category: 'learn',
        categoryLabel: 'Learn',
      }),
      guideFixture('python/lambda', 'python', 1, {
        catalogMode: 'legacy',
        category: 'deploy',
        categoryLabel: 'Deploy',
      }),
      guideFixture('typescript/first-agent', 'typescript', 2, {
        catalogMode: 'legacy',
        category: 'learn',
        categoryLabel: 'Learn',
      }),
    ]

    expect(buildSampleGuideSidebar(legacyEntries, legacyEntries[0])).toEqual([
      {
        label: 'Python',
        collapsed: false,
        items: [
          {
            label: 'Learn',
            collapsed: false,
            items: [{ label: 'python/first-agent', link: '/examples/python/first-agent/' }],
          },
          {
            label: 'Deploy',
            collapsed: false,
            items: [{ label: 'python/lambda', link: '/examples/python/lambda/' }],
          },
        ],
      },
    ])
  })
})
