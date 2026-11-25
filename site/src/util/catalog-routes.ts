/**
 * Routes of the integrations catalog. `/integrations/` lists every entry, and
 * each type has its own page at `/docs/integrations/<slug>/`, so the build
 * marks the right sidebar link current with no script. Paths here are
 * site-relative; wrap them in pathWithBase() for links.
 */

import { CATALOG_TYPES } from '../components/catalog/types'
import { pathWithBase } from './links'

export const CATALOG_PATH = '/integrations/'

const SLUG_BY_TYPE = new Map<string, string>(CATALOG_TYPES.map((t) => [t.value, t.slug]))

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
 * Where an old `/integrations/?type=<type>` link now lives: the type's page,
 * keeping the other query parameters (search, the open docs drawer, ...).
 * Returns null when the query doesn't name exactly one known type, so several
 * types (`?type=a,b`) keep filtering on the catalog page.
 *
 * Self-contained on purpose: the catalog page inlines its source in <head> so
 * the redirect runs before anything paints.
 */
export function legacyTypeRedirect(search: string, typePaths: Record<string, string>): string | null {
  const params = new URLSearchParams(search)
  const type = params.get('type')
  if (!type || !Object.prototype.hasOwnProperty.call(typePaths, type)) return null
  params.delete('type')
  const query = params.toString()
  return typePaths[type] + (query ? `?${query}` : '')
}
