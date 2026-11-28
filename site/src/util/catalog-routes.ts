/**
 * Routes of the integrations catalog. `/integrations/` lists every entry, and
 * each type has its own page at `/docs/integrations/<slug>/`, so the build
 * marks the right sidebar link current with no script. An integration's docs
 * page sits under its type (`/docs/integrations/storage/github/`) and opens as
 * a dialog over that type's catalog (components/IntegrationModal.astro). Paths
 * here are site-relative; wrap them in pathWithBase() for links.
 */

import { CATALOG_TYPES } from '../components/catalog/types'
import { pathWithBase } from './links'

export const CATALOG_PATH = '/integrations/'

const SLUG_BY_TYPE = new Map<string, string>(CATALOG_TYPES.map((t) => [t.value, t.slug]))
const TYPE_BY_SLUG = new Map<string, string>(CATALOG_TYPES.map((t) => [t.slug, t.value]))

/** The catalog page for one type, e.g. `storage` → `/docs/integrations/storage/`. */
export function catalogTypePath(type: string): string {
  const slug = SLUG_BY_TYPE.get(type)
  if (!slug) throw new Error(`Unknown catalog type: ${type}`)
  return `/docs/integrations/${slug}/`
}

/** Every type page path, keyed by type value. */
export function catalogTypePaths(): Record<string, string> {
  return Object.fromEntries(CATALOG_TYPES.map((t) => [t.value, catalogTypePath(t.value)]))
}

/** Whether a URL pathname (with the site base) is the catalog or one of its type pages. */
export function isCatalogPath(pathname: string): boolean {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`
  return [CATALOG_PATH, ...Object.values(catalogTypePaths())].some((p) => pathWithBase(p) === normalized)
}

/**
 * The catalog type of an integration docs page, from its Starlight id: the
 * page's folder names the type (`docs/integrations/storage/github` → `storage`).
 * Undefined for pages outside a type folder, such as "Add your integration".
 */
export function integrationPageType(id: string): string | undefined {
  const match = /^docs\/integrations\/([^/]+)\/[^/]+/.exec(id)
  return match?.[1] ? TYPE_BY_SLUG.get(match[1]) : undefined
}

/**
 * Where an old catalog link now lives:
 * - `?entry=<id>` (the old docs drawer): that entry's docs page.
 * - `?type=<type>`: the type's page.
 *
 * The other query parameters (search, language, ...) are kept. Returns null
 * when neither applies, so several types (`?type=a,b`) keep filtering on the
 * catalog page.
 *
 * Self-contained on purpose: catalog pages inline its source in <head> so the
 * redirect runs before anything paints.
 */
export function legacyCatalogRedirect(
  search: string,
  typePaths: Record<string, string>,
  entryPaths: Record<string, string>
): string | null {
  const params = new URLSearchParams(search)
  const own = (map: Record<string, string>, key: string | null) =>
    key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null
  const target = own(entryPaths, params.get('entry')) || own(typePaths, params.get('type'))
  if (!target) return null
  params.delete('entry')
  params.delete('type')
  const query = params.toString()
  return target + (query ? `?${query}` : '')
}
