import path from 'node:path'
import { getCollection } from 'astro:content'
import { loadSidebarFromConfig, type StarlightSidebarItem } from '../sidebar'
import { pathWithBase } from './links'

/** A page link or a labeled group of them, mirroring a product's docs sidebar. */
export type ProductNavItem =
  | { type: 'link'; label: string; href: string; external?: boolean }
  | { type: 'group'; label: string; items: ProductNavItem[] }

// Built once per build: the nav renders on every page but the tree is static.
let cached: Promise<StarlightSidebarItem[]> | undefined
let labelsCached: Promise<Map<string, string>> | undefined

function getSidebar(): Promise<StarlightSidebarItem[]> {
  cached ??= Promise.resolve(
    loadSidebarFromConfig(path.resolve('./src/config/navigation.yml'), path.resolve('./src/content'))
  )
  return cached
}

/** Docs id -> sidebar label, resolved the same way Starlight does (sidebar.label, then title). */
function getLabels(): Promise<Map<string, string>> {
  labelsCached ??= getCollection('docs').then(
    (docs) => new Map(docs.map((doc) => [doc.id, doc.data.sidebar?.label ?? doc.data.title]))
  )
  return labelsCached
}

function toNavItem(item: StarlightSidebarItem, labels: Map<string, string>): ProductNavItem | null {
  if ('items' in item) {
    const items = item.items.map((child) => toNavItem(child, labels)).filter((c) => c !== null)
    return items.length > 0 ? { type: 'group', label: item.label, items } : null
  }
  if ('link' in item) {
    return { type: 'link', label: item.label, href: item.link, external: /^https?:\/\//.test(item.link) }
  }
  const label = item.label ?? labels.get(item.slug)
  if (!label) return null
  return { type: 'link', label, href: pathWithBase(`/${item.slug}/`) }
}

function hasSlug(item: StarlightSidebarItem, slug: string): boolean {
  if ('items' in item) return item.items.some((child) => hasSlug(child, slug))
  return 'slug' in item && item.slug === slug
}

/**
 * The full sidebar tree of the product whose hub page is `hubHref`, for the
 * mobile menu. Matched by hub page rather than label because product and
 * sidebar group labels differ (e.g. "Evals" vs "Evals SDK").
 */
export async function getProductNav(hubHref: string): Promise<ProductNavItem[]> {
  const [sidebar, labels] = await Promise.all([getSidebar(), getLabels()])
  const hubSlug = hubHref.replace(pathWithBase('/'), '').replace(/\/$/, '')
  const group = sidebar.find((item) => 'items' in item && hasSlug(item, hubSlug))
  if (!group || !('items' in group)) return []
  return group.items.map((item) => toNavItem(item, labels)).filter((i) => i !== null)
}
