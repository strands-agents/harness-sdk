/**
 * Pure helpers for the integration docs dialog (components/IntegrationModal.astro).
 * Kept free of DOM access so vitest can test them directly.
 */

/**
 * Whether a URL pathname is an integration docs page that opens in the dialog:
 * any page below a type's catalog page (`/docs/integrations/storage/github/`
 * under `/docs/integrations/storage/`), but not the catalog page itself.
 */
export function isModalPath(pathname: string, typePaths: string[]): boolean {
  return typePaths.some((p) => pathname.startsWith(p) && pathname.length > p.length)
}

/**
 * The catalog URL that closing the dialog shows: the catalog's own path with the
 * filters from the current query (`?q=git` on a docs page carries to the catalog
 * behind it). The fragment belongs to the docs page and is dropped.
 */
export function catalogUrlFor(catalogPath: string, search: string): string {
  const query = new URLSearchParams(search).toString()
  return catalogPath + (query ? `?${query}` : '')
}

/**
 * A page title with its leading heading swapped (`GitHub | Strands Agents` →
 * `Storage | Strands Agents`), for the catalog behind a docs page.
 */
export function titleWithHeading(title: string, heading: string): string {
  if (!heading) return title
  const separator = title.indexOf(' | ')
  return separator < 0 ? heading : heading + title.slice(separator)
}
