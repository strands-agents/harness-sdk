import { navLinks, products } from '../config/navbar'
import type { Product } from '../sidebar'

// Sections that are products (have a slug + hub). Examples/Community are docs
// sections but not products, so they get no product eyebrow/switcher.
// Must match the navbar labels in navigation.yml exactly; a stale entry silently
// drops that product's hub hero and sidebar box.
const PRODUCT_LABELS = new Set(['Harness', 'Harness SDK', 'Shell', 'Evals'])

/**
 * The product whose section the given path falls in, by longest-basePath match
 * against the navbar — the same rule the sidebar-scoping middleware uses.
 * Returns undefined on non-product pages (Examples, Community, API, home).
 */
export function currentProduct(pathname: string): Product | undefined {
  let bestLabel: string | undefined
  let bestLen = 0
  for (const link of navLinks) {
    if (link.external || !PRODUCT_LABELS.has(link.label)) continue
    const bps = link.basePath ? (Array.isArray(link.basePath) ? link.basePath : [link.basePath]) : [link.href]
    for (const bp of bps) {
      if (pathname.startsWith(bp) && bp.length > bestLen) {
        bestLabel = link.label
        bestLen = bp.length
      }
    }
  }
  return bestLabel ? products.find((p) => p.label === bestLabel) : undefined
}
