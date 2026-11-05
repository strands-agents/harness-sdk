import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { getCollection } from 'astro:content'
import { beforeAll, describe, expect, it } from 'vitest'

import { getPublishedPosts } from '../src/util/blog'
import { releaseSlug } from '../src/util/changelog'

type JsonLdNode = Record<string, unknown>

const distDir = path.resolve('dist')
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
  it('describes every product with its source repository on the homepage', () => {
    const graph = page('/')
    const products = ofType(graph, 'SoftwareApplication')

    expect(graph.map((node) => node['@type'])).toEqual([
      'Organization',
      'WebSite',
      ...products.map(() => 'SoftwareApplication'),
    ])
    expect(products.map((product) => product.name)).toEqual(
      expect.arrayContaining([
        'Strands harness',
        'Strands Harness SDK',
        'Strands Shell',
        'Strands Box',
        'Strands Evals',
      ])
    )
    for (const product of products) {
      expect((product.isBasedOn as JsonLdNode).codeRepository).toMatch(/^https:\/\/github\.com\/strands-agents\//)
    }
  })

  it('ties guides to the product they document', () => {
    const graph = page('/docs/user-guide/sdk/agents/agent-loop/')
    const [article] = ofType(graph, 'TechArticle')
    const [product] = ofType(graph, 'SoftwareApplication')

    expect(product?.name).toBe('Strands Harness SDK')
    expect(article?.headline).toBeTruthy()
    expect(article?.about).toEqual({ '@id': product?.['@id'] })
    expect(article?.publisher).toEqual({ '@id': graph[0]?.['@id'] })
  })

  it('marks API reference pages as APIReference', () => {
    for (const route of ['/docs/api/python/strands.agent.agent/', '/docs/api/typescript/Agent/']) {
      const graph = page(route)
      const [reference] = ofType(graph, 'APIReference')

      expect(reference?.headline, route).toBeTruthy()
      expect(reference?.about, route).toEqual({ '@id': ofType(graph, 'SoftwareApplication')[0]?.['@id'] })
      expect(ofType(graph, 'TechArticle'), route).toHaveLength(0)
    }
  })

  it('emits an article without a product on learning lessons', () => {
    const [article] = ofType(page('/docs/learning/evaluating-agents/'), 'TechArticle')

    expect(article?.headline).toBe('Lesson 13: Evaluating agents')
    expect(article?.about).toBeUndefined()
  })

  it('publishes release metadata on every changelog release page', async () => {
    const releases = await getCollection('changelog')
    expect(releases.length).toBeGreaterThan(0)
    for (const release of releases) {
      const route = `/changelog/${releaseSlug(release)}/`
      const [product, node] = ofType(page(route), 'SoftwareApplication')
      if (release.data.sdk === 'cli') expect(product?.softwareVersion, route).toBe(release.data.version)
      else expect(node?.isPartOf, route).toEqual({ '@id': product?.['@id'] })

      expect(release.data.sdk === 'cli' ? product : node, route).toMatchObject({
        '@type': 'SoftwareApplication',
        softwareVersion: release.data.version,
        datePublished: release.data.date.toISOString(),
        downloadUrl: release.data.packageUrl,
      })
    }
  })

  it('lists every catalog entry on /integrations/', async () => {
    const entries = await getCollection('catalog')
    const [list] = ofType(page('/integrations/'), 'ItemList')
    const items = (list?.itemListElement as JsonLdNode[]).map((element) => element.item as JsonLdNode)

    expect(list?.numberOfItems).toBe(entries.length)
    expect(items.map((item) => item.codeRepository).sort()).toEqual(entries.map((entry) => entry.data.github).sort())
    for (const item of items) expect(item['@type']).toBe('SoftwareSourceCode')
  })

  it('keeps BlogPosting in the page graph', async () => {
    const posts = await getPublishedPosts()
    expect(posts.length).toBeGreaterThan(0)
    for (const post of posts) {
      const [posting] = ofType(page(`/blog/${post.id}/`), 'BlogPosting')

      expect(posting?.headline, post.id).toBe(post.data.title)
      expect(posting?.publisher, post.id).toEqual({ '@id': page('/')[0]?.['@id'] })
    }
  })

  it('links sample guides to their source', async () => {
    for (const guide of await getCollection('sampleGuides')) {
      const route = `/examples/${guide.data.slug}/`
      expect(existsSync(path.join(distDir, route, 'index.html')), route).toBe(true)
      const [article] = ofType(page(route), 'TechArticle')

      expect((article?.isBasedOn as JsonLdNode[])[0]?.url, route).toBe(guide.data.sourceUrl)
    }
  })
})
