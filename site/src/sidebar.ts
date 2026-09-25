import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { isNew, NEW_BADGE } from './util/new-badge'

// A badge rendered next to a sidebar label. A bare string is shorthand for the default variant.
type SidebarBadge = string | { text: string; variant?: 'note' | 'tip' | 'caution' | 'danger' | 'success' | 'default' }

// Starlight sidebar item types
export type StarlightSidebarItem =
  | { slug: string; label?: string; attrs?: Record<string, string> } // Internal link
  | { label: string; link: string; attrs?: Record<string, string> } // External link
  | { label: string; items: StarlightSidebarItem[]; collapsed?: boolean; badge?: SidebarBadge } // Group

// Navigation config types
interface NavConfigItem {
  label?: string
  items?: NavConfigItem[]
  slug?: string // For labeled leaf items "Adding Tools"
  href?: string // For link items pointing outside the docs collection (e.g. a project repo)
  external?: boolean // Opens the href in a new tab
  collapsed?: boolean // Explicit collapse state for groups (overrides auto-collapse)
  badge?: SidebarBadge // Badge on a group label (leaf badges come from page frontmatter)
  addedDate?: string | Date // Derives a "New" badge on a group for NEW_BADGE_DAYS; never hand-write one
}
type NavConfigEntry = string | NavConfigItem

interface NavbarLink {
  label: string
  href: string
  basePath?: string
  external?: boolean
}

export interface GitHubLink {
  label: string
  href: string
  icon?: string
}

export interface GitHubSection {
  title: string
  links: GitHubLink[]
}

/** A page link shown under a product in the Docs dropdown / mobile menu. */
export interface ProductLink {
  label: string
  href: string
}

/**
 * A top-level product (Shell, Strands harness, Box, Evals, …). The single source of
 * truth for the Docs dropdown and — going forward — the scoped sidebar, so the
 * nav and the docs stay aligned. Add a product here and it appears everywhere.
 */
export interface Product {
  /** Internal key; must match the navbar entry's label so scoping and lookup line up. */
  label: string
  /** Full product name shown in the hub hero and the sidebar box, e.g. "Strands harness". */
  name: string
  /** Short brand slug used in URLs and the Projects dropdown, e.g. "/shell". */
  slug: string
  href: string
  description: string
  pages?: ProductLink[]
}

interface NavigationConfig {
  navbar: NavbarLink[]
  sidebar: NavConfigItem[]
  products?: Product[]
  github: {
    sections: GitHubSection[]
  }
}

interface ConvertContext {
  contentDir: string
  buildDate: Date
}

function deriveGroupBadge(item: NavConfigItem, buildDate: Date): SidebarBadge | undefined {
  if (item.badge !== undefined) return item.badge
  if (item.addedDate && isNew(new Date(item.addedDate), buildDate)) {
    return NEW_BADGE
  }
  return undefined
}

/**
 * Check if a content file exists for a given slug
 */
function contentExists(slug: string, contentDir: string): boolean {
  if (!contentDir) return true

  const candidates = [
    path.join(contentDir, `${slug}.md`),
    path.join(contentDir, `${slug}.mdx`),
    path.join(contentDir, slug, 'index.md'),
    path.join(contentDir, slug, 'index.mdx'),
  ]

  return candidates.some((p) => fs.existsSync(p))
}

/**
 * Convert a navigation config item to Starlight sidebar format
 */
function convertConfigItem(item: NavConfigEntry, ctx: ConvertContext): StarlightSidebarItem | null {
  // String: slug only (e.g., "docs/user-guide/quickstart/overview")
  if (typeof item === 'string') {
    if (!contentExists(item, ctx.contentDir)) return null
    return { slug: item }
  }

  // Object with label and items (group)
  if (typeof item === 'object' && item !== null) {
    if (item.label && item.items) {
      const children = item.items
        .map((child) => convertConfigItem(child, ctx))
        .filter((c): c is StarlightSidebarItem => c !== null)

      if (children.length === 0) return null

      const badge = deriveGroupBadge(item, ctx.buildDate)
      return {
        label: item.label,
        items: children,
        ...(typeof item.collapsed === 'boolean' && { collapsed: item.collapsed }),
        ...(badge !== undefined && { badge }),
      }
    }

    // Object with label and slug (labeled leaf item)
    if (item.label && item.slug) {
      if (!contentExists(item.slug, ctx.contentDir)) return null
      return { slug: item.slug, label: item.label }
    }

    // Object with label and href (link outside the docs collection)
    if (item.label && item.href) {
      return {
        label: item.label,
        link: item.href,
        ...(item.external && { attrs: { target: '_blank', rel: 'noopener noreferrer' } }),
      }
    }
  }

  return null
}

/**
 * Load navigation configuration from YAML file
 */
export function loadNavigationConfig(configPath: string): NavigationConfig {
  const content = fs.readFileSync(configPath, 'utf-8')
  return yaml.load(content) as NavigationConfig
}

/**
 * Load sidebar from navigation.yml config
 */
export function loadSidebarFromConfig(
  configPath: string,
  docsContentDir?: string,
  buildDate: Date = new Date()
): StarlightSidebarItem[] {
  const config = loadNavigationConfig(configPath)
  if (!config.sidebar) return []

  const ctx: ConvertContext = { contentDir: docsContentDir || '', buildDate }

  const items = config.sidebar
    .map((item) => convertConfigItem(item, ctx))
    .filter((i): i is StarlightSidebarItem => i !== null)

  return items
}

/**
 * Load navbar links from navigation.yml config
 */
export function loadNavbarFromConfig(configPath: string): NavbarLink[] {
  const config = loadNavigationConfig(configPath)
  return config.navbar || []
}

/**
 * Load GitHub sections from navigation.yml config
 */
export function loadGitHubSectionsFromConfig(configPath: string): GitHubSection[] {
  const config = loadNavigationConfig(configPath)
  return config.github?.sections || []
}

/**
 * Load the product list from navigation.yml config.
 */
export function loadProductsFromConfig(configPath: string): Product[] {
  const config = loadNavigationConfig(configPath)
  return config.products || []
}
