/**
 * Utilities for resolving relative links to Astro slugs, which provides a better devx than
 * using slugs everywhere, though that's always an option.
 */

// github-slugger is what Astro uses internally for default slug generation;
// pathToDocsSlug relies on it to stay byte-compatible with Astro's ids.
import { slug as githubSlug } from 'github-slugger'

/**
 * Check if a link uses the @api shorthand format.
 * Supported formats:
 * - @api/python/strands.module.path
 * - @api/python/strands.module.path#SubPath
 * - @api/typescript/ClassName
 * - @api/typescript/ClassName#method
 *
 * @param link - The href to check
 * @returns true if the link uses @api shorthand
 */
export function isApiShorthand(link: string): boolean {
  return link.startsWith('@api/')
}

/**
 * Resolve an @api shorthand link to an absolute path.
 *
 * @param link - The @api shorthand link (e.g., `@api/python/strands.agent.agent`)
 * @returns The resolved absolute path (e.g., `/api/python/strands.agent.agent/`)
 */
export function resolveApiShorthand(link: string): string {
  // Remove the @api/ prefix
  const withoutPrefix = link.slice(5) // '@api/'.length === 5

  // Split path and anchor
  const hashIndex = withoutPrefix.indexOf('#')
  const pathPart = hashIndex !== -1 ? withoutPrefix.slice(0, hashIndex) : withoutPrefix
  const anchor = hashIndex !== -1 ? withoutPrefix.slice(hashIndex) : ''

  // The path is already in the correct format (python/strands.module or typescript/ClassName)
  return `/docs/api/${pathPart}/${anchor}`
}

/**
 * Get the site's base URL path, stripped of trailing slash for consistent concatenation.
 * This is used to build URLs that work correctly when the site is deployed at a subpath.
 */
export function getBase(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '')
}

/**
 * Get the full site origin (scheme + host) from the SITE_URL environment variable.
 * Returns an empty string if SITE_URL is not set, so URLs remain relative.
 *
 * Set SITE_DOMAIN=https://strandsagents.com when building for production to get
 * absolute URLs in llms.txt / llms-full.txt.
 */
export function getSiteOrigin(): string {
  const siteUrl = import.meta.env.SITE_DOMAIN
  if (!siteUrl) return ''
  return siteUrl.replace(/\/$/, '')
}

/**
 * Build a URL path with the site's base path prefix.
 * Ensures the path works correctly when deployed at a subpath (e.g., example.com/docs/).
 *
 * @param path - The path to prefix (e.g., `/api/python/` or `api/python/`)
 * @returns The path with base prefix (e.g., `/docs/api/python/`)
 */
export function pathWithBase(path: string): string {
  const base = getBase()
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : '/' + path
  return base + normalizedPath
}

/**
 * Build a site URL with the configured origin and base path.
 * Returns a base-aware path when SITE_DOMAIN is not set.
 */
export function siteLink(path: string): string {
  return getSiteOrigin() + pathWithBase(path)
}

/**
 * Normalize a file path or href to a slug by removing extensions and index/README suffixes.
 * This is the shared logic used by both content collection ID generation and link resolution.
 *
 * @param path - A file path (e.g., `user-guide/concepts/agents/state.mdx`) or href
 * @returns The normalized slug (e.g., `user-guide/concepts/agents/state`)
 */
export function normalizePathToSlug(path: string): string {
  let result = path

  // Remove trailing slash
  if (result.endsWith('/')) {
    result = result.slice(0, -1)
  }

  // Remove .md or .mdx extension
  result = result.replace(/\.mdx?$/, '')

  // Handle index -> parent directory
  if (result.endsWith('/index')) {
    result = result.slice(0, -6) // Remove '/index'
  } else if (result === 'index') {
    result = ''
  }

  // Handle README -> parent directory
  if (result.endsWith('/readme') || result.endsWith('/README')) {
    result = result.slice(0, -7) // Remove '/readme' or '/README'
  } else if (result === 'readme' || result === 'README') {
    result = ''
  }

  return result
}

/**
 * Derive the docs content-collection ID (slug) for a content file path:
 * an explicit frontmatter `slug` wins, otherwise the path is normalized and
 * each segment slugified the same way Astro's default loader does.
 *
 * Single source of truth shared by content.config.ts (generateDocsId) and
 * redirect.static.ts, which must agree on ids or redirect stubs point at 404s.
 *
 * @param entryPath - Content-collection-relative file path (e.g. `docs/user-guide/state.mdx`)
 * @param slugOverride - The frontmatter `slug` value, if any
 */
export function pathToDocsSlug(entryPath: string, slugOverride?: unknown): string {
  if (slugOverride) {
    return `${slugOverride}`
  }

  const normalized = normalizePathToSlug(entryPath)

  // Root README/index -> 'index' (Starlight convention for the homepage)
  if (!normalized) {
    return 'index'
  }

  return normalized
    .split('/')
    .map((segment) => githubSlug(segment))
    .join('/')
}

/**
 * Check if a link is relative (MkDocs-style) vs absolute or external.
 *
 * @param link - The href to check
 * @returns true if the link is relative and needs resolution
 */
export function isRelativeLink(link: string): boolean {
  // Absolute URLs or protocol-relative URLs
  if (link.startsWith('http://') || link.startsWith('https://') || link.startsWith('//')) {
    return false
  }
  // Absolute paths
  if (link.startsWith('/')) {
    return false
  }
  // Anchor-only links
  if (link.startsWith('#')) {
    return false
  }
  return true
}

/**
 * Normalize a path by resolving `.` and `..` segments.
 *
 * @param segments - Array of path segments
 * @returns Normalized array with `.` removed and `..` resolved
 */
export function normalizePath(segments: string[]): string[] {
  const result: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      result.pop()
    } else if (segment !== '.' && segment !== '') {
      result.push(segment)
    }
  }
  return result
}

/**
 * Normalize a relative href by removing extensions and handling index/README.
 *
 * @param relativeHref - The relative link href
 * @returns Object with normalized path and anchor
 */
function normalizeRelativeHref(relativeHref: string): { pathPart: string; anchor: string } {
  // Separate path and anchor
  const hashIndex = relativeHref.indexOf('#')
  const anchor = hashIndex !== -1 ? relativeHref.slice(hashIndex) : ''
  const pathPart = hashIndex !== -1 ? relativeHref.slice(0, hashIndex) : relativeHref

  return { pathPart: normalizePathToSlug(pathPart), anchor }
}

interface ResolveRelativeLinkOptions {
  /** The relative link href (e.g., `../tools/custom-tools.md#section`) */
  href: string
  /** The current page's URL path (e.g., `/user-guide/concepts/agents/state/`) */
  currentPath: string
  /** If true, treat the current path as an index page (directory = full path) */
  asIndexPage?: boolean
}

/**
 * Convert a relative MkDocs link to an Astro slug path.
 *
 * In MkDocs, links are relative to the current file's location.
 * For example, from `user-guide/concepts/agents/state.md`:
 * - `conversation-management.md` -> `user-guide/concepts/agents/conversation-management`
 * - `../tools/index.md` -> `user-guide/concepts/tools`
 *
 * @returns The resolved path with anchor (e.g., `user-guide/concepts/tools/custom-tools#section`)
 */
export function resolveRelativeLink(options: ResolveRelativeLinkOptions): string {
  const { href, currentPath, asIndexPage = false } = options
  const { pathPart, anchor } = normalizeRelativeHref(href)

  // Clean up the current path
  const currentDir = currentPath.replace(/^\/+/, '').replace(/\/+$/, '')

  // The current path segments
  const currentSegments = currentDir.split('/').filter(Boolean)

  // Determine base segments based on whether this is an index page
  // - Index page: /user-guide/concepts/tools/ -> directory is user-guide/concepts/tools
  // - Regular page: /user-guide/concepts/agents/state/ -> directory is user-guide/concepts/agents
  const baseSegments = asIndexPage ? currentSegments : currentSegments.slice(0, -1)

  // Parse the relative path
  const relativeSegments = pathPart.split('/').filter(Boolean)

  // Combine base and relative segments, then normalize
  const combined = [...baseSegments, ...relativeSegments]
  const resolved = normalizePath(combined)

  return resolved.join('/') + anchor
}

/**
 * Find a matching doc slug for a resolved path.
 *
 * @param resolvedPath - The resolved path (e.g., `user-guide/concepts/tools/custom-tools#section`)
 * @param docSlugs - Set of valid doc slugs from the content collection
 * @returns The full URL path with trailing slash (e.g., `/user-guide/concepts/tools/custom-tools/#section`) or null if not found
 */
export function findDocSlug(resolvedPath: string, docSlugs: Set<string>): string | null {
  // Remove anchor for lookup
  const hashIndex = resolvedPath.indexOf('#')
  const pathWithoutAnchor = hashIndex !== -1 ? resolvedPath.slice(0, hashIndex) : resolvedPath
  const anchor = hashIndex !== -1 ? resolvedPath.slice(hashIndex) : ''

  // Direct match
  if (docSlugs.has(pathWithoutAnchor)) {
    return '/' + pathWithoutAnchor + '/' + anchor
  }

  // Try common variations
  const variations = [pathWithoutAnchor, pathWithoutAnchor.replace(/\/$/, '')] // Remove trailing slash

  for (const variation of variations) {
    if (docSlugs.has(variation)) {
      return '/' + variation + '/' + anchor
    }
  }

  return null
}

/**
 * Convert a local path/slug to its raw markdown URL.
 * Handles paths with or without leading/trailing slashes and anchors.
 * Skips paths that point to concrete files (with extensions like .txt, .json, etc.)
 *
 * @param path - The path or slug (e.g., `/user-guide/foo/`, `user-guide/foo`, `/user-guide/foo/#section`)
 * @returns The raw markdown URL (e.g., `/user-guide/foo/index.md`, `/user-guide/foo/index.md#section`)
 */
export function toRawMarkdownUrl(path: string): string {
  // Skip if already pointing to index.md
  if (path.endsWith('/index.md') || path.includes('/index.md#')) {
    return path
  }

  // Extract anchor if present
  let anchor = ''
  const anchorIndex = path.indexOf('#')
  if (anchorIndex !== -1) {
    anchor = path.slice(anchorIndex)
    path = path.slice(0, anchorIndex)
  }

  // Clean trailing slash
  const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path

  // Skip paths that point to concrete files (have a file extension)
  // This handles .txt, .json, .html, .pdf, etc.
  const lastSegment = cleanPath.split('/').pop() || ''
  if (lastSegment.includes('.')) {
    return `${cleanPath}${anchor}`
  }

  return `${cleanPath}/index.md${anchor}`
}

/**
 * Check if a link is a local link (not external, not anchor-only).
 *
 * @param href - The href to check
 * @returns true if the link is local and could be converted to raw.md
 */
export function isLocalLink(href: string): boolean {
  if (!href) return false
  if (href.startsWith('http://') || href.startsWith('https://')) return false
  if (href.startsWith('#')) return false
  return true
}

/**
 * Resolve a potentially relative href to an absolute Astro URL.
 *
 * This is the main entry point for link resolution. It handles:
 * - @api shorthand links (e.g., `@api/python/strands.agent.agent`)
 * - Absolute URLs (returned as-is)
 * - Anchor-only links (returned as-is)
 * - Relative MkDocs-style links (resolved against current path and doc collection)
 *
 * The function tries two interpretations of the current path:
 * 1. As a regular page (last segment is the page name)
 * 2. As an index page (last segment is the directory name)
 *
 * It returns the first interpretation that produces a valid slug.
 *
 * @param href - The href to resolve
 * @param currentPath - The current page's URL path
 * @param docSlugs - Set of valid doc slugs from the content collection
 * @returns Object with resolved href and whether it was found in the collection
 */
export function resolveHref(
  href: string,
  currentPath: string,
  docSlugs: Set<string>
): { resolvedHref: string; found: boolean } {
  // Special case: known static files that should resolve with base path
  const knownStaticFiles = ['llms.txt', 'llms-full.txt']
  for (const file of knownStaticFiles) {
    if (href === file || href === `/${file}` || href.endsWith(`/${file}`)) {
      return { resolvedHref: `/${file}`, found: true }
    }
  }

  // Handle @api shorthand links
  if (isApiShorthand(href)) {
    const resolved = resolveApiShorthand(href)
    // Extract the slug part (without leading/trailing slashes and anchor)
    const hashIndex = resolved.indexOf('#')
    const pathOnly = hashIndex !== -1 ? resolved.slice(0, hashIndex) : resolved
    const slugPart = pathOnly.replace(/^\//, '').replace(/\/$/, '')
    const found = docSlugs.has(slugPart)
    // Apply base path for @api links since they resolve to absolute paths
    return { resolvedHref: resolved, found }
  }

  if (!isRelativeLink(href)) {
    return { resolvedHref: href, found: true }
  }

  // Try resolving as a regular page first (most common case)
  const resolvedAsRegular = resolveRelativeLink({ href, currentPath, asIndexPage: false })
  const foundAsRegular = findDocSlug(resolvedAsRegular, docSlugs)

  if (foundAsRegular) {
    return { resolvedHref: foundAsRegular, found: true }
  }

  // Try resolving as an index page
  const resolvedAsIndex = resolveRelativeLink({ href, currentPath, asIndexPage: true })
  const foundAsIndex = findDocSlug(resolvedAsIndex, docSlugs)

  if (foundAsIndex) {
    return { resolvedHref: foundAsIndex, found: true }
  }

  // Fallback: construct a path anyway (will 404 but helps debugging)
  // Use the regular page interpretation for the fallback
  const anchor = href.includes('#') ? href.slice(href.indexOf('#')) : ''
  const pathOnly = resolvedAsRegular.split('#')[0] ?? resolvedAsRegular
  return { resolvedHref: '/' + pathOnly + '/' + anchor, found: false }
}
