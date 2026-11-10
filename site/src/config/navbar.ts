/**
 * Navigation bar links and GitHub dropdown configuration.
 *
 * This module reads navigation configuration from navigation.yml and exports
 * processed data for use in Header component.
 */

import path from 'node:path'
import { loadNavigationConfig, type GitHubSection, type Product } from '../sidebar'

export interface NavLink {
  /** Display label for the link */
  label: string
  /** URL path or full URL for external links */
  href: string
  /**
   * Base path(s) used to determine active state and sidebar filtering (optional).
   * If not provided, href is used. Can be a single string or an array of strings
   * when a nav item encompasses multiple top-level sidebar sections.
   * Example: basePath: ["/docs/integrations/", "/docs/labs/", "/docs/contribute/"]
   */
  basePath?: string | string[]
  /** Set to true for external links (opens in new tab) */
  external?: boolean
  /** Set to 'right' to push this link to the right side of the nav bar */
  align?: 'right'
}

/**
 * Get the configured base path, normalized to have leading slash and no trailing slash.
 * Returns empty string if base is root '/'.
 */
function getBasePath(): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalized = base.replace(/\/$/, '')
  return normalized === '' ? '' : normalized
}

/**
 * Prepend base path to a path string.
 */
function withBase(path: string): string {
  const base = getBasePath()
  if (!base) return path
  return base + path
}

/**
 * Transform nav links to include the base path in href and basePath.
 * External links are left unchanged.
 */
function transformNavLinks(links: NavLink[]): NavLink[] {
  return links.map((link): NavLink => {
    if (link.external) return link
    const bp = link.basePath
    return {
      ...link,
      href: withBase(link.href),
      ...(bp ? { basePath: Array.isArray(bp) ? bp.map(withBase) : withBase(bp) } : {}),
    }
  })
}

// Load configuration from navigation.yml
const configPath = path.resolve('./src/config/navigation.yml')
const config = loadNavigationConfig(configPath)
const rawNavLinks: NavLink[] = config.navbar || []
const rawGithubSections: GitHubSection[] = config.github?.sections || []
const rawProducts: Product[] = config.products || []

/**
 * Navigation links with base path applied.
 * Use this for rendering and comparisons.
 */
export const navLinks: NavLink[] = transformNavLinks(rawNavLinks)

/**
 * GitHub sections for the header dropdown.
 */
export const githubSections: GitHubSection[] = rawGithubSections

/**
 * Products for the "Docs" dropdown, with base path applied to all hrefs. This
 * is the single source of truth for the product-oriented navigation.
 */
export const products: Product[] = rawProducts.map((p) => ({
  ...p,
  href: withBase(p.href),
  ...(p.pages ? { pages: p.pages.map((pg) => ({ ...pg, href: withBase(pg.href) })) } : {}),
}))
