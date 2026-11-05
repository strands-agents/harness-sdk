import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getCollection } from 'astro:content'
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
  sampleId?: string
  catalogMode?: 'legacy' | 'curated'
  family?: string
  variants?: string[]
  placement?: 'featured' | 'reference'
  category?: string
  categoryLabel?: string
  collections?: Array<{ id: string; label: string; description?: string; order: number }>
  program?: string
  kind?: 'application' | 'workshop' | 'concept' | 'integration' | 'migration'
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
      sampleId: options.sampleId ?? slug,
      catalogMode,
      title: slug,
      description: `${slug} description`,
      slug,
      language,
      category: options.category ?? 'learn',
      categoryLabel: options.categoryLabel ?? 'Learn',
      placement: options.placement ?? 'featured',
      kind: options.kind ?? (catalogMode === 'curated' ? 'application' : undefined),
      collections: options.collections ?? [],
      capabilities: [],
      docs: [],
      variants: options.variants ?? [],
      family: options.family,
      program: options.program,
      sourceUrl: `https://github.com/strands-agents/samples/tree/commit/${slug}`,
      order,
    },
  } as SampleGuideEntry
}

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
      expect(page.querySelector('#featured-examples')).toBeNull()
      expect(page.querySelectorAll('[data-sample-placement]')).toHaveLength(0)
      expect(page.querySelectorAll('.sample-card__badges')).toHaveLength(0)
      expect(page.querySelectorAll('.sl-link-card')).toHaveLength(0)
      return
    }

    expect(page.querySelector('[data-pagefind-body]')).not.toBeNull()
    expect(page.querySelector('html[data-has-sidebar]')).not.toBeNull()
    expect(page.querySelector('.product-switcher__slug')?.textContent.trim()).toBe('/examples')
    expect(page.querySelector('.sample-catalog__intro')?.textContent.trim()).toBe(
      'Explore complete examples, organized by what you want to learn or build.'
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
      ).toEqual(section.families.map((family) => family.key))

      for (const family of section.families) {
        const card = renderedSection?.querySelector(`.sl-link-card[data-sample-family="${family.key}"]`)
        const primary =
          family.guides.find((guide) => guide.data.language === DEFAULT_LANGUAGE_LABEL.toLowerCase()) ?? family.primary
        expect(card?.querySelector('.sample-link-card__title')?.getAttribute('href'), family.key).toBe(
          sampleGuideHref(primary)
        )
        expect(card?.querySelector('.sample-link-card__title')?.textContent.trim(), family.key).toBe(primary.data.title)
        expect(card?.querySelector('.sample-link-card__description')?.textContent.trim(), family.key).toBe(
          primary.data.description
        )
        for (const guide of family.guides) {
          expect(
            card?.querySelector(`.sample-link-card__languages a[href="${sampleGuideHref(guide)}"]`)?.textContent.trim(),
            guide.id
          ).toBe(languageLabel(guide.data.language))
        }
      }
    }

    expect(page.querySelectorAll('[data-sample-placement]')).toHaveLength(0)
    expect(page.querySelectorAll('.sample-card__badges, .sample-card__program')).toHaveLength(0)
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
      expect(page.querySelector('[data-pagefind-body]') !== null).toBe(
        guide.data.catalogMode === 'curated' || guide.data.placement === 'featured'
      )
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
      if (guide.data.catalogMode === 'curated' || guide.data.placement === 'featured') {
        expect(llms, guide.id).toContain(`[${label}](`)
        expect(llms, guide.id).toContain(sourcePath)
        expect(llmsFull, guide.id).toContain(`## ${label}`)
        expect(llmsFull, guide.id).toContain(guide.data.sourceUrl)
        expect(llmsFull, guide.id).toContain(`Markdown: `)
        expect(llmsFull, guide.id).toContain(sourcePath)
      } else {
        expect(llms, guide.id).not.toContain(sourcePath)
        expect(llmsFull, guide.id).not.toContain(sourcePath)
      }
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

  it('uses an explicit variant relationship when no family is declared', () => {
    const entries = [
      guideFixture('python/migration', 'python', 0, {
        sampleId: 'python-migration',
        variants: ['typescript-migration'],
      }),
      guideFixture('typescript/different-slug', 'typescript', 1, {
        sampleId: 'typescript-migration',
      }),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/migration', 'typescript')).toBe(
      '/examples/typescript/different-slug/'
    )
  })

  it('falls back to an explicit variant when a family counterpart is unavailable', () => {
    const entries = [
      guideFixture('python/migration', 'python', 0, {
        sampleId: 'python-migration',
        family: 'python-only-family',
        variants: ['typescript-migration'],
      }),
      guideFixture('typescript/different-slug', 'typescript', 1, {
        sampleId: 'typescript-migration',
      }),
    ]

    expect(sampleGuideSwitchPath(entries, 'python/migration', 'typescript')).toBe(
      '/examples/typescript/different-slug/'
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
  it('groups nine featured guides into eight editorial families', () => {
    const entries = [
      guideFixture('python/dynamic-ui', 'python', 0, { family: 'dynamic-ui' }),
      guideFixture('typescript/dynamic-ui', 'typescript', 1, { family: 'dynamic-ui' }),
      ...Array.from({ length: 7 }, (_, index) => guideFixture(`python/example-${index + 1}`, 'python', index + 2)),
    ]

    const families = groupSampleGuideFamilies(entries)

    expect(entries).toHaveLength(9)
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
      ...entries.slice(2).map((entry) => ({
        key: entry.data.sampleId,
        primary: entry.data.slug,
        guides: [entry.data.slug],
      })),
    ])
  })

  it('groups three supplemental references into two migration actions', () => {
    const references = [
      guideFixture('typescript/express', 'typescript', 0, { placement: 'reference' }),
      guideFixture('python/langgraph', 'python', 1, {
        family: 'langgraph-migration',
        placement: 'reference',
      }),
      guideFixture('typescript/langgraph', 'typescript', 2, {
        family: 'langgraph-migration',
        placement: 'reference',
      }),
    ]

    expect(
      groupSampleGuideFamilies(references).map((family) => ({
        key: family.key,
        primary: family.primary.data.slug,
        guides: family.guides.map((guide) => guide.data.slug),
      }))
    ).toEqual([
      {
        key: 'typescript/express',
        primary: 'typescript/express',
        guides: ['typescript/express'],
      },
      {
        key: 'langgraph-migration',
        primary: 'python/langgraph',
        guides: ['python/langgraph', 'typescript/langgraph'],
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
        placement: 'reference',
        collections: [migrate],
      }),
      guideFixture('python/dynamic-ui', 'python', 1, {
        family: 'dynamic-ui',
        collections: [userExperiences],
      }),
      guideFixture('typescript/dynamic-ui', 'typescript', 2, {
        family: 'dynamic-ui',
        collections: [userExperiences],
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
  const learn = [{ id: 'learn', label: 'Learn', order: 0 }]
  const migrate = [{ id: 'migrate', label: 'Migrate', order: 1 }]
  const entries = [
    guideFixture('typescript/learn', 'typescript', 0, { collections: learn }),
    guideFixture('python/learn', 'python', 1, { collections: learn }),
    guideFixture('typescript/migrate', 'typescript', 2, {
      placement: 'reference',
      collections: migrate,
    }),
    guideFixture('python/migrate', 'python', 3, {
      placement: 'reference',
      collections: migrate,
    }),
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

  it('scopes a guide sidebar to its language without hiding reference guides', () => {
    expect(buildSampleGuideSidebar(entries, entries[3])).toEqual([expectedPython])
  })
})
