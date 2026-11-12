import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { getCollection } from 'astro:content'
import { beforeAll, describe, expect, it } from 'vitest'

import { LANGUAGE_META, PRODUCT_RELEASE_STREAM, SDK_META } from '../src/config/changelog'
import { homepageProducts, products } from '../src/config/navbar'
import { getPublishedPosts, resolveAuthors } from '../src/util/blog'
import { sortEntries, toCardModel } from '../src/util/catalog'
import { releaseSlug } from '../src/util/changelog'
import { relatedUserGuideFor } from '../src/util/related-docs'
import { languageLabel } from '../src/util/source-links'
import { baseSchemas, faqPageSchema, integrationsSchema, productId, productSchema } from '../src/util/structured-data'
import { faqAnswerText, faqItems } from '../src/config/faq'

type JsonLdNode = Record<string, unknown>

const distDir = path.resolve('dist')
const site = (process.env.SITE_DOMAIN || 'https://strandsagents.com').replace(/\/$/, '')
const organization = { '@id': `${site}/#organization` }
const base = (process.env.ASTRO_BASE_PATH ?? '/').replace(/\/$/, '')
const jsonLdScript = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g

// schema.org properties (inherited ones included) for every type the site emits.
const THING = ['@type', '@id', 'name', 'description', 'url', 'sameAs', 'image', 'mainEntityOfPage']
const CREATIVE_WORK = [
  ...THING,
  'about',
  'author',
  'dateModified',
  'datePublished',
  'headline',
  'isBasedOn',
  'isPartOf',
  'keywords',
  'license',
  'offers',
  'publisher',
]
const PROPERTIES: Record<string, string[]> = {
  Organization: [...THING, 'logo', 'parentOrganization'],
  WebSite: CREATIVE_WORK,
  WebPage: [...CREATIVE_WORK, 'relatedLink'],
  TechArticle: CREATIVE_WORK,
  APIReference: CREATIVE_WORK,
  BlogPosting: CREATIVE_WORK,
  SoftwareApplication: [...CREATIVE_WORK, 'applicationCategory', 'downloadUrl', 'releaseNotes', 'softwareVersion'],
  SoftwareSourceCode: [...CREATIVE_WORK, 'codeRepository', 'programmingLanguage'],
  BreadcrumbList: [...THING, 'itemListElement', 'numberOfItems'],
  ItemList: [...THING, 'itemListElement', 'numberOfItems'],
  FAQPage: [...CREATIVE_WORK, 'mainEntity'],
  Question: [...CREATIVE_WORK, 'acceptedAnswer'],
  Answer: [...CREATIVE_WORK, 'text'],
  ListItem: [...THING, 'position', 'item'],
  Offer: [...THING, 'price', 'priceCurrency'],
  Person: THING,
}

function isRedirectStub(html: string): boolean {
  return html.includes('http-equiv="refresh"')
}

function builtPages(dir: string, pages = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) builtPages(entryPath, pages)
    if (entry.name !== 'index.html') continue
    const html = readFileSync(entryPath, 'utf8')
    if (!isRedirectStub(html)) pages.set('/' + path.relative(distDir, dir).split(path.sep).join('/'), html)
  }
  return pages
}

function routeOf(route: string): string {
  return route.replace(/\/$/, '') || '/'
}

function graphOf(html: string): JsonLdNode[] {
  const [script] = [...html.matchAll(jsonLdScript)]
  return (JSON.parse(script?.[1] ?? '{}') as { '@graph': JsonLdNode[] })['@graph']
}

/** Every object in a JSON-LD value, depth-first. */
function nodesIn(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) return value.flatMap(nodesIn)
  if (typeof value !== 'object' || value === null) return []
  return [value as JsonLdNode, ...Object.values(value).flatMap(nodesIn)]
}

function ofType(graph: JsonLdNode[], type: string): JsonLdNode[] {
  return graph.filter((node) => node['@type'] === type)
}

let pages: Map<string, string>

function page(route: string): JsonLdNode[] {
  const html = pages.get(routeOf(route))
  expect(html, route).toBeDefined()
  return graphOf(html ?? '')
}

beforeAll(() => {
  pages = builtPages(distDir)
})

describe('structured data on every built page', () => {
  it('emits exactly one parseable JSON-LD graph', () => {
    expect(pages.size).toBeGreaterThan(100)
    for (const [route, html] of pages) {
      const scripts = [...html.matchAll(jsonLdScript)]
      expect(scripts, route).toHaveLength(1)
      const parsed = JSON.parse(scripts[0]?.[1] ?? '')
      expect(parsed['@context'], route).toBe('https://schema.org')
      expect(Array.isArray(parsed['@graph']), route).toBe(true)
    }
  })

  it('uses only schema.org properties of each type', () => {
    for (const [route, html] of pages) {
      for (const node of nodesIn(graphOf(html))) {
        const type = node['@type']
        const allowed = typeof type === 'string' ? PROPERTIES[type] : ['@id']
        expect(allowed, `${route}: unknown type ${String(type)}`).toBeDefined()
        for (const key of Object.keys(node)) expect(allowed, `${route}: ${String(type)}.${key}`).toContain(key)
      }
    }
  })

  it('resolves every @id reference within the page graph', () => {
    for (const [route, html] of pages) {
      const nodes = nodesIn(graphOf(html))
      const ids = new Set(nodes.filter((node) => node['@type']).map((node) => node['@id']))
      for (const node of nodes.filter((node) => !node['@type'])) expect(ids, route).toContain(node['@id'])
    }
  })

  it('links breadcrumbs only to built pages', () => {
    for (const [route, html] of pages) {
      for (const list of ofType(graphOf(html), 'BreadcrumbList')) {
        const items = list.itemListElement as JsonLdNode[]
        expect(items.length, route).toBeGreaterThan(1)
        for (const item of items.slice(0, -1)) {
          const pathname = new URL(item.item as string).pathname.slice(base.length)
          expect(pages.has(routeOf(pathname)), `${route} -> ${pathname}`).toBe(true)
        }
        expect(items.at(-1)?.item, route).toBeUndefined()
      }
    }
  })
})

describe('structured data per page type', () => {
  const sdk = products.find((product) => product.label === 'Harness SDK')!
  const routeUrl = (route: string) => `${site}${base}${route}`

  it('configures every product with a source repository and languages', () => {
    for (const product of products) {
      expect(product.repository, product.label).toMatch(/^https:\/\/github\.com\/strands-(?:agents|labs)\//)
      expect(product.languages.length, product.label).toBeGreaterThan(0)
    }
  })

  it('describes the products featured on the homepage', () => {
    expect(page('/')).toEqual([
      ...baseSchemas(site),
      ...homepageProducts.map((product) => productSchema(product, site)),
    ])
  })

  it('ties guides to the product they document', async () => {
    const docs = await getCollection('docs')
    const entry = docs.find((doc) => doc.id === 'docs/user-guide/sdk/agents/agent-loop')!
    const url = routeUrl('/docs/user-guide/sdk/agents/agent-loop/')
    const related = relatedUserGuideFor(entry, docs)
    expect(related.length).toBeGreaterThan(0)

    expect(ofType(page('/docs/user-guide/sdk/agents/agent-loop/'), 'TechArticle')).toEqual([
      {
        '@type': 'TechArticle',
        headline: 'Agent Loop',
        description: entry.data.description,
        url,
        mainEntityOfPage: {
          '@type': 'WebPage',
          '@id': url,
          relatedLink: related.map((doc) => `${site}/${doc.slug}/`),
        },
        dateModified: expect.any(String),
        author: organization,
        publisher: organization,
        about: { '@id': productId(sdk, site) },
        keywords: 'event-loop, tool-execution, hooks',
        isBasedOn: [
          {
            '@type': 'SoftwareSourceCode',
            programmingLanguage: 'Python',
            codeRepository: 'https://github.com/strands-agents/harness-sdk',
            url: 'https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py',
          },
          {
            '@type': 'SoftwareSourceCode',
            programmingLanguage: 'Python',
            codeRepository: 'https://github.com/strands-agents/harness-sdk',
            url: 'https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/event_loop.py',
          },
          {
            '@type': 'SoftwareSourceCode',
            programmingLanguage: 'TypeScript',
            codeRepository: 'https://github.com/strands-agents/harness-sdk',
            url: 'https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts',
          },
        ],
      },
    ])
  })

  it('marks API reference pages as APIReference', () => {
    for (const [route, headline] of [
      ['/docs/api/python/strands.agent.agent/', 'strands.agent.agent'],
      ['/docs/api/typescript/Agent/', 'Agent'],
    ]) {
      const graph = page(route)
      const url = routeUrl(route)

      expect(ofType(graph, 'TechArticle'), route).toEqual([])
      expect(ofType(graph, 'APIReference'), route).toEqual([
        {
          '@type': 'APIReference',
          headline,
          url,
          mainEntityOfPage: { '@type': 'WebPage', '@id': url },
          author: organization,
          publisher: organization,
          about: { '@id': productId(sdk, site) },
        },
      ])
    }
  })

  it('emits an article without a product on learning lessons', () => {
    const url = routeUrl('/docs/learning/evaluating-agents/')

    expect(ofType(page('/docs/learning/evaluating-agents/'), 'TechArticle')).toEqual([
      {
        '@type': 'TechArticle',
        headline: 'Lesson 13: Evaluating agents',
        description: expect.any(String),
        url,
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
        dateModified: expect.any(String),
        author: organization,
        publisher: organization,
      },
    ])
  })

  it('publishes release metadata on every changelog release page', async () => {
    const releases = await getCollection('changelog')
    expect(releases.length).toBeGreaterThan(0)
    for (const release of releases) {
      const { data } = release
      const route = `/changelog/${releaseSlug(release)}/`
      const url = routeUrl(route)
      const product = products.find((p) => PRODUCT_RELEASE_STREAM[p.label] === data.sdk)
      const name = product?.name ?? `Strands ${SDK_META[data.sdk].label}`

      expect(
        page(route).find((node) => node['@id'] === `${url}#release`),
        route
      ).toEqual({
        '@type': 'SoftwareApplication',
        '@id': `${url}#release`,
        name: data.language ? `${name} ${LANGUAGE_META[data.language].label}` : name,
        softwareVersion: data.version,
        datePublished: data.date.toISOString(),
        releaseNotes: url,
        downloadUrl: data.packageUrl,
        applicationCategory: 'DeveloperApplication',
        publisher: organization,
        ...(product && { isPartOf: { '@id': productId(product, site) } }),
      })
    }
  })

  it('lists every catalog entry on /integrations/', async () => {
    const entries = await getCollection('catalog')
    const cards = sortEntries(entries.map((entry) => toCardModel(entry.id, entry.data, undefined, new Date())))

    expect(ofType(page('/integrations/'), 'ItemList')).toEqual([
      integrationsSchema(cards, routeUrl('/integrations/'), site),
    ])
  })

  it('publishes every curated question on /faq/', () => {
    expect(ofType(page('/faq/'), 'FAQPage')).toEqual([
      faqPageSchema(
        faqItems.map((item) => ({
          question: item.question,
          answer: faqAnswerText(item.answer),
        })),
        routeUrl('/faq/')
      ),
    ])
  })

  it('keeps BlogPosting in the page graph', async () => {
    const posts = await getPublishedPosts()
    expect(posts.length).toBeGreaterThan(0)
    for (const post of posts) {
      const route = `/blog/${post.id}/`
      const authors = await resolveAuthors(post.data.authors)

      expect(ofType(page(route), 'BlogPosting'), post.id).toEqual([
        {
          '@type': 'BlogPosting',
          headline: post.data.title,
          description: post.data.description,
          image: routeUrl(`/blog/og/${post.id}.png`),
          mainEntityOfPage: { '@type': 'WebPage', '@id': post.data.canonicalUrl ?? routeUrl(route) },
          datePublished: post.data.date.toISOString(),
          author: authors.map((author) => ({
            '@type': 'Person',
            name: author.data.name,
            url: routeUrl(`/blog/authors/${author.id}/`),
          })),
          publisher: organization,
        },
      ])
    }
  })

  it('links sample guides to the samples repository', async () => {
    for (const guide of await getCollection('sampleGuides')) {
      const route = `/examples/${guide.data.slug}/`
      const url = routeUrl(route)
      expect(existsSync(path.join(distDir, route, 'index.html')), route).toBe(true)

      expect(ofType(page(route), 'TechArticle'), route).toEqual([
        {
          '@type': 'TechArticle',
          headline: guide.data.title,
          description: guide.data.description,
          url,
          mainEntityOfPage: { '@type': 'WebPage', '@id': url },
          author: organization,
          publisher: organization,
          isBasedOn: [
            {
              '@type': 'SoftwareSourceCode',
              programmingLanguage: languageLabel(guide.data.language),
              codeRepository: 'https://github.com/strands-agents/samples',
              url: guide.data.sourceUrl,
            },
          ],
        },
      ])
    }
  })
})
