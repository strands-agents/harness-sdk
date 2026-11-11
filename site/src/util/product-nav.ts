import path from 'node:path'
import type { StarlightRouteData } from '@astrojs/starlight/route-data'
import { getCollection } from 'astro:content'
import { loadSidebarFromConfig, type StarlightSidebarItem } from '../sidebar'
import { pathWithBase } from './links'

/** A page link or a labeled group of them, mirroring a product's docs sidebar. */
export type ProductNavItem =
  | { type: 'link'; label: string; href: string; external?: boolean }
  | { type: 'group'; label: string; items: ProductNavItem[] }

/** Convert Starlight's normalized route sidebar into the mobile navigation shape. */
export function normalizedSidebarToProductNav(sidebar: StarlightRouteData['sidebar']): ProductNavItem[] {
  return sidebar.map((entry) =>
    entry.type === 'group'
      ? {
          type: 'group',
          label: entry.label,
          items: normalizedSidebarToProductNav(entry.entries),
        }
      : {
          type: 'link',
          label: entry.label,
          href: entry.href,
          ...(/^https?:\/\//.test(entry.href) && { external: true }),
        }
  )
}

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

function hasSlugAtOrBelow(item: StarlightSidebarItem, slug: string): boolean {
  if ('items' in item) return item.items.some((child) => hasSlugAtOrBelow(child, slug))
  return 'slug' in item && (item.slug === slug || item.slug.startsWith(`${slug}/`))
}

function findGroupByLabel(
  items: StarlightSidebarItem[],
  labels: Set<string>
): Extract<StarlightSidebarItem, { items: StarlightSidebarItem[] }> | undefined {
  for (const item of items) {
    if (!('items' in item)) continue
    if (labels.has(item.label)) return item
    const nested = findGroupByLabel(item.items, labels)
    if (nested) return nested
  }
  return undefined
}

/**
 * The full sidebar tree of the product whose hub page is `hubHref`, for the
 * mobile menu. Prefer an explicit product or navigation label so a product
 * nested inside a broader section can still own its mobile tree. Fall back to
 * the hub route because some product and sidebar labels differ (for example,
 * "Evals" and "Evals SDK").
 */
export async function getProductNav(hubHref: string, groupLabels: string[] = []): Promise<ProductNavItem[]> {
  const [sidebar, labels] = await Promise.all([getSidebar(), getLabels()])
  const hubSlug = hubHref.replace(pathWithBase('/'), '').replace(/\/$/, '')
  const group =
    findGroupByLabel(sidebar, new Set(groupLabels)) ??
    sidebar.find((item) => 'items' in item && hasSlugAtOrBelow(item, hubSlug))
  if (!group || !('items' in group)) return []
  return group.items.map((item) => toNavItem(item, labels)).filter((i) => i !== null)
}
