/**
 * Shared JSON-LD structured data schemas for SEO.
 * Head.astro emits one @graph per page; pages that own a node pass it in via
 * `Astro.locals.structuredData`.
 */

import { LANGUAGE_META, SDK_META } from '../config/changelog'
import { pathWithBase } from './links'
import type { CatalogCardModel } from './catalog'
import type { ChangelogFrontmatter } from '../content.config'
import type { Product } from '../sidebar'

export type JsonLdNode = Record<string, unknown>

/**
 * Serialize JSON-LD for insertion into a script element with `set:html`.
 *
 * JSON.stringify does not escape `<`, so a string containing `</script>` can
 * terminate the element before the browser parses the JSON. Escaping `<` as a
 * JSON Unicode sequence preserves the parsed value without creating HTML.
 */
export function serializeJsonLd(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export interface BreadcrumbItem {
  '@type': 'ListItem'
  position: number
  name: string
  item?: string
}

// Landing pages outside the docs collection; every other ancestor must be a docs page.
const sectionPages = new Map([
  ['blog', 'Blog'],
  ['changelog', 'Changelog'],
  ['examples', 'Examples'],
  ['integrations', 'Integrations'],
])

/**
 * Build breadcrumb JSON-LD from the canonical route id, naming each ancestor after its
 * page title. Ancestors without a page (e.g. `/docs/api/`, `/changelog/sdk/`) are dropped.
 */
export function buildBreadcrumbItems(
  routeId: string,
  title: string,
  siteUrl: string,
  pageTitles: Map<string, string>,
  basePath = ''
): BreadcrumbItem[] {
  const segments = routeId
    .replace(/^\/|\/$/g, '')
    .split('/')
    .filter(Boolean)
  const ancestors = segments.slice(0, -1).flatMap((_, index) => {
    const id = segments.slice(0, index + 1).join('/')
    const name = pageTitles.get(id) ?? sectionPages.get(id)
    return name ? [{ name, item: `${siteUrl}${basePath}/${id}/` }] : []
  })

  return [...ancestors, { name: title }].map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, ...crumb }))
}

const APACHE_LICENSE = 'https://www.apache.org/licenses/LICENSE-2.0'

export function organizationRef(siteUrl: string): JsonLdNode {
  return { '@id': `${siteUrl}/#organization` }
}

export function baseSchemas(siteUrl: string): JsonLdNode[] {
  return [
    {
      '@type': 'Organization',
      '@id': `${siteUrl}/#organization`,
      name: 'Strands Agents',
      url: siteUrl,
      logo: siteUrl + '/favicon.svg',
      sameAs: ['https://github.com/strands-agents'],
      parentOrganization: {
        '@type': 'Organization',
        name: 'Amazon Web Services',
        url: 'https://aws.amazon.com',
      },
    },
    // No potentialAction/SearchAction: site search is Pagefind, a client-side
    // modal with no query-parameter URL — a SearchAction target would be fake.
    {
      '@type': 'WebSite',
      '@id': `${siteUrl}/#website`,
      name: 'Strands Agents',
      url: siteUrl,
      publisher: organizationRef(siteUrl),
    },
  ]
}

export function productId(product: Product, siteUrl: string): string {
  return `${siteUrl}${product.href}#software`
}

export function productSchema(product: Product, siteUrl: string): JsonLdNode {
  return {
    '@type': 'SoftwareApplication',
    '@id': productId(product, siteUrl),
    name: product.name,
    description: product.description,
    url: siteUrl + product.href,
    applicationCategory: 'DeveloperApplication',
    license: APACHE_LICENSE,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: organizationRef(siteUrl),
    isBasedOn: {
      '@type': 'SoftwareSourceCode',
      codeRepository: product.repository,
      programmingLanguage: product.languages,
    },
  }
}

export interface ArticleSource {
  programmingLanguage: string
  codeRepository: string
  url: string
}

export interface ArticleInput {
  type: 'TechArticle' | 'APIReference'
  title: string
  description?: string | undefined
  url: string
  dateModified?: Date | undefined
  keywords?: string[]
  relatedLinks?: string[]
  sources?: ArticleSource[]
  product?: Product | undefined
}

export function articleSchema(input: ArticleInput, siteUrl: string): JsonLdNode {
  const { keywords = [], relatedLinks = [], sources = [] } = input
  return {
    '@type': input.type,
    headline: input.title,
    ...(input.description && { description: input.description }),
    url: input.url,
    // relatedLink is a WebPage property, so it lives on the page, not the article.
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': input.url,
      ...(relatedLinks.length > 0 && { relatedLink: relatedLinks }),
    },
    ...(input.dateModified && { dateModified: input.dateModified.toISOString() }),
    author: organizationRef(siteUrl),
    publisher: organizationRef(siteUrl),
    ...(input.product && { about: { '@id': productId(input.product, siteUrl) } }),
    ...(keywords.length > 0 && { keywords: keywords.join(', ') }),
    ...(sources.length > 0 && {
      isBasedOn: sources.map((source) => ({ '@type': 'SoftwareSourceCode', ...source })),
    }),
  }
}

/** One release of a product's stream, linked to the product node when it has one. */
export function releaseSchema(
  release: ChangelogFrontmatter,
  pageUrl: string,
  siteUrl: string,
  product: Product | undefined
): JsonLdNode {
  const name = [
    product?.name ?? `Strands ${SDK_META[release.sdk].label}`,
    release.language && LANGUAGE_META[release.language].label,
  ]
    .filter(Boolean)
    .join(' ')
  return {
    '@type': 'SoftwareApplication',
    '@id': `${pageUrl}#release`,
    name,
    softwareVersion: release.version,
    datePublished: release.date.toISOString(),
    releaseNotes: pageUrl,
    downloadUrl: release.packageUrl,
    applicationCategory: 'DeveloperApplication',
    publisher: organizationRef(siteUrl),
    ...(product && { isPartOf: { '@id': productId(product, siteUrl) } }),
  }
}

export function integrationsSchema(cards: CatalogCardModel[], pageUrl: string, siteUrl: string): JsonLdNode {
  return {
    '@type': 'ItemList',
    '@id': `${pageUrl}#integrations`,
    name: 'Strands Agents integrations',
    numberOfItems: cards.length,
    itemListElement: cards.map((card, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'SoftwareSourceCode',
        name: card.name,
        description: card.description,
        url: card.external ? card.href : siteUrl + pathWithBase(card.href),
        codeRepository: card.github,
        programmingLanguage: card.languages.map((language) => LANGUAGE_META[language].label),
      },
    })),
  }
}
