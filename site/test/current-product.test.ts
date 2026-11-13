import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadNavbarFromConfig, loadProductsFromConfig } from '../src/sidebar'
import { PRODUCT_RELEASE_STREAM } from '../src/config/changelog'
import { docsHrefForProduct, products as renderedProducts } from '../src/config/navbar'
import {
  changelogHrefForProduct,
  documentationIssueHref,
  issueRepositoryForProduct,
  PRODUCT_ISSUE_REPOSITORY,
} from '../src/config/footer'

const configPath = path.resolve('./src/config/navigation.yml')

// currentProduct() resolves a page to its product by matching the navbar
// entry's label against products[].label. If those drift (a rename touches
// one but not the other), that product silently loses its hub hero and sidebar
// box, with no build error. These tests make that drift loud.
describe('product identity wiring', () => {
  const navbar = loadNavbarFromConfig(configPath)
  const products = loadProductsFromConfig(configPath)

  it('every product has a matching navbar entry with a basePath', () => {
    for (const p of products) {
      const nav = navbar.find((l) => l.label === p.label)
      expect(nav, `navbar entry for product label "${p.label}"`).toBeDefined()
      expect(nav?.basePath, `basePath for "${p.label}"`).toBeTruthy()
    }
  })

  it('every product has a release-stream entry for the docs footer', () => {
    for (const p of products) {
      expect(PRODUCT_RELEASE_STREAM, `PRODUCT_RELEASE_STREAM entry for "${p.label}"`).toHaveProperty([p.label])
    }
    expect(PRODUCT_RELEASE_STREAM).toEqual({
      Harness: 'harness',
      'Harness SDK': 'sdk',
      Shell: 'shell',
      Box: 'box',
      Evals: 'evals',
      Decider: null,
    })
  })

  it('every product routes issues to its owning repository', () => {
    for (const p of products) {
      expect(PRODUCT_ISSUE_REPOSITORY, `PRODUCT_ISSUE_REPOSITORY entry for "${p.label}"`).toHaveProperty([p.label])
    }
    expect(PRODUCT_ISSUE_REPOSITORY).toEqual({
      Harness: 'harness-sdk',
      'Harness SDK': 'harness-sdk',
      Shell: 'shell',
      Box: 'box',
      Evals: 'evals',
      Decider: 'strands-labs/strands-decider',
    })
  })

  it('every product has a display name and a slash slug', () => {
    for (const p of products) {
      expect(p.name, `name for "${p.label}"`).toMatch(/^Strands /)
      expect(p.slug, `slug for "${p.label}"`).toMatch(/^\/[a-z-]+$/)
    }
  })

  it('every product resolves from its docs-scoped navbar path', async () => {
    const { currentProduct } = await import('../src/util/current-product')
    for (const p of products) {
      const nav = navbar.find((item) => item.label === p.label)
      const docsPaths = Array.isArray(nav?.basePath) ? nav.basePath : [nav?.basePath ?? nav?.href]
      for (const docsPath of docsPaths.filter((value): value is string => Boolean(value))) {
        const resolved = currentProduct(docsPath)
        expect(resolved?.label, `currentProduct("${docsPath}")`).toBe(p.label)
      }
    }
    expect(currentProduct('/docs/learning/how-agents-really-work/')).toBeUndefined()
  })

  it('separates the Box landing page from its docs navigation scope', async () => {
    const { currentProduct } = await import('../src/util/current-product')
    const box = renderedProducts.find((product) => product.label === 'Box')
    expect(box?.href).toBe('/box/')
    expect(box && docsHrefForProduct(box)).toBe('/docs/user-guide/box/')
    expect(currentProduct('/box/')).toBeUndefined()
    expect(currentProduct('/docs/user-guide/box/quickstart/')?.label).toBe('Box')
  })
})

describe('docs footer links', () => {
  it('filters the changelog for a product and leaves site-wide links generic', () => {
    expect(changelogHrefForProduct('/changelog/', 'box')).toBe('/changelog/?sdk=box')
    expect(changelogHrefForProduct('/changelog/', undefined)).toBe('/changelog/')
  })

  it('uses the documentation form in harness-sdk', () => {
    const pageUrl = 'https://strandsagents.com/docs/user-guide/sdk/'
    const url = new URL(documentationIssueHref(issueRepositoryForProduct('Harness SDK'), pageUrl))
    expect(url.pathname).toBe('/strands-agents/harness-sdk/issues/new')
    expect(url.searchParams.get('template')).toBe('documentation_improvement.yml')
    expect(url.searchParams.get('documentation-section')).toBe(pageUrl)
    expect(issueRepositoryForProduct(undefined)).toBe('harness-sdk')
  })

  it('prefills a generic issue in product repositories without the documentation form', () => {
    const pageUrl = 'https://strandsagents.com/docs/user-guide/box/'
    const url = new URL(documentationIssueHref(issueRepositoryForProduct('Box'), pageUrl))
    expect(url.pathname).toBe('/strands-agents/box/issues/new')
    expect(url.searchParams.get('template')).toBeNull()
    expect(url.searchParams.get('title')).toBe('Documentation issue')
    expect(url.searchParams.get('body')).toContain(pageUrl)
  })

  it('routes Decider issues to the strands-labs repository', () => {
    const pageUrl = 'https://strandsagents.com/docs/labs/strands-decider/overview/'
    const url = new URL(documentationIssueHref(issueRepositoryForProduct('Decider'), pageUrl))
    expect(url.pathname).toBe('/strands-labs/strands-decider/issues/new')
    expect(url.searchParams.get('body')).toContain(pageUrl)
  })
})
