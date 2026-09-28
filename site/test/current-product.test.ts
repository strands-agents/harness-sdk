import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadNavbarFromConfig, loadProductsFromConfig } from '../src/sidebar'

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

  it('every product has a display name and a slash slug', () => {
    for (const p of products) {
      expect(p.name, `name for "${p.label}"`).toMatch(/^Strands /)
      expect(p.slug, `slug for "${p.label}"`).toMatch(/^\/[a-z-]+$/)
    }
  })

  it('every product resolves from its own hub href', async () => {
    const { currentProduct } = await import('../src/util/current-product')
    for (const p of products) {
      const resolved = currentProduct(p.href)
      expect(resolved?.label, `currentProduct("${p.href}")`).toBe(p.label)
    }
  })
})
