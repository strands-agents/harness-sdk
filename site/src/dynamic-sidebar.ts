import type { StarlightRouteData } from '@astrojs/starlight/route-data'
import { pathWithBase } from './util/links'

type SidebarEntry = StarlightRouteData['sidebar'][number]
type SidebarGroup = Extract<SidebarEntry, { type: 'group' }>
type SidebarLink = Extract<SidebarEntry, { type: 'link' }>

export type { SidebarEntry, SidebarGroup, SidebarLink }

/**
 * Convert module_name to Display Name (e.g., "bidi_types" -> "Bidi Types")
 */
export function getDisplayName(moduleName: string): string {
  return moduleName
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Convert category name to display name for TypeScript API
 */
function getCategoryDisplayName(category: string): string {
  const mapping: Record<string, string> = {
    classes: 'Classes',
    interfaces: 'Interfaces',
    'type-aliases': 'Type Aliases',
    functions: 'Functions',
    namespaces: 'Namespaces',
  }
  return mapping[category] || category
}

/**
 * Minimal doc info needed for sidebar generation
 */
export interface DocInfo {
  id: string
  title: string
  category?: string | undefined // For TypeScript API docs
}

/**
 * Build a hierarchical sidebar from Python API docs.
 * Groups modules by their path segments after "strands."
 *
 * Example:
 * - strands.agent.agent -> Agent > Agent
 * - strands.experimental.bidi.types -> Experimental > Bidi > Types
 */
export function buildPythonApiSidebar(docs: DocInfo[], currentSlug: string): SidebarEntry[] {
  const pythonApiDocs = docs.filter(
    (doc) => doc.id.startsWith('docs/api/python/') && !doc.id.endsWith('docs/api/python/index')
  )

  // Build a nested structure from module names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree: Record<string, any> = {}

  for (const doc of pythonApiDocs) {
    // Extract module name from title (e.g., "strands.agent.agent")
    const moduleName = doc.title
    if (!moduleName.startsWith('strands.')) continue

    // Split into parts after "strands." (e.g., ["agent", "agent"])
    const parts = moduleName.replace('strands.', '').split('.')

    // Build nested tree structure
    let current = tree
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!
      if (!current[part]) {
        current[part] = { __children: {} }
      }
      current = current[part].__children
    }

    // Add the leaf node with doc info
    const leafName = parts[parts.length - 1]!
    current[leafName] = {
      __doc: doc,
      __children: current[leafName]?.__children ?? {},
    }
  }

  // Convert tree to sidebar entries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function treeToSidebar(node: Record<string, any>, depth: number = 0): SidebarEntry[] {
    const entries: SidebarEntry[] = []

    for (const [key, value] of Object.entries(node)) {
      const displayName = getDisplayName(key)
      const hasChildren = Object.keys(value.__children).length > 0
      const hasDoc = value.__doc !== undefined

      if (hasDoc && !hasChildren) {
        // Leaf node - create a link
        const doc = value.__doc
        const href = pathWithBase(`/${doc.id}/`)
        const link: SidebarLink = {
          type: 'link',
          label: displayName,
          href,
          isCurrent: currentSlug === doc.id,
          badge: undefined,
          attrs: {},
        }
        entries.push(link)
      } else if (hasChildren) {
        // Group node
        const childEntries = treeToSidebar(value.__children, depth + 1)

        // If this node also has a doc, add it as the first item in the group
        if (hasDoc) {
          const doc = value.__doc
          const href = pathWithBase(`/${doc.id}/`)
          childEntries.unshift({
            type: 'link',
            label: 'Overview',
            href,
            isCurrent: currentSlug === doc.id,
            badge: undefined,
            attrs: {},
          })
        }

        const group: SidebarGroup = {
          type: 'group',
          label: displayName,
          entries: childEntries,
          collapsed: depth >= 1,
          badge: undefined,
        }
        entries.push(group)
      }
    }

    // Sort entries: alphabetically A-Z, with "Experimental" at the end
    return entries.sort((a, b) => {
      // Experimental always goes last
      if (a.label === 'Experimental') return 1
      if (b.label === 'Experimental') return -1

      // Alphabetically regardless of type
      return a.label.localeCompare(b.label)
    })
  }

  return treeToSidebar(tree)
}

/**
 * Build a sidebar from TypeScript API docs.
 * Groups by category (classes, interfaces, type-aliases, functions).
 * Note: Slugs are flat (api/typescript/Agent) but sidebar groups by type.
 *
 * Example structure:
 * - Classes
 *   - Agent
 *   - Model
 * - Interfaces
 *   - AgentConfig
 * - Type Aliases
 *   - ToolList
 * - Functions
 *   - tool
 */
export function buildTypeScriptApiSidebar(docs: DocInfo[], currentSlug: string): SidebarEntry[] {
  const tsApiDocs = docs.filter(
    (doc) => doc.id.startsWith('docs/api/typescript/') && !doc.id.endsWith('docs/api/typescript/index')
  )

  // Group docs by category from frontmatter
  const categories: Record<string, DocInfo[]> = {
    classes: [],
    interfaces: [],
    'type-aliases': [],
    functions: [],
    namespaces: [],
  }

  for (const doc of tsApiDocs) {
    const category = doc.category
    if (category && category in categories) {
      categories[category]!.push(doc)
    }
  }

  // Build sidebar entries
  const entries: SidebarEntry[] = []

  // Define category order
  const categoryOrder = ['namespaces', 'classes', 'interfaces', 'type-aliases', 'functions']

  for (const category of categoryOrder) {
    const categoryDocs = categories[category]
    if (!categoryDocs || categoryDocs.length === 0) continue

    // Sort docs alphabetically by title
    categoryDocs.sort((a, b) => a.title.localeCompare(b.title))

    const links: SidebarLink[] = categoryDocs.map((doc) => ({
      type: 'link',
      label: doc.title,
      href: pathWithBase(`/${doc.id}/`),
      isCurrent: currentSlug === doc.id,
      badge: undefined,
      attrs: {},
    }))

    const group: SidebarGroup = {
      type: 'group',
      label: getCategoryDisplayName(category),
      entries: links,
      collapsed: false,
      badge: undefined,
    }

    entries.push(group)
  }

  return entries
}

/**
 * Course sidebar: a group of lesson links. The course start page is reached
 * from the /learn switcher box (see Sidebar.astro), so there is no back-link.
 */
export function buildCourseSidebar(
  docs: DocInfo[],
  currentSlug: string,
  course: { title: string; lessonIds: string[] },
): SidebarEntry[] {
  const docById = new Map(docs.map((d) => [d.id, d]))

  const lessonLinks: SidebarLink[] = course.lessonIds
    .filter((id) => docById.has(id))
    .map((id) => {
      const doc = docById.get(id)!
      return {
        type: 'link',
        label: doc.title,
        href: pathWithBase(`/${doc.id}/`),
        isCurrent: currentSlug === doc.id,
        badge: undefined,
        attrs: {},
      }
    })

  if (lessonLinks.length === 0) {
    return []
  }

  const group: SidebarGroup = {
    type: 'group',
    label: course.title,
    entries: lessonLinks,
    collapsed: false,
    badge: undefined,
  }

  return [group]
}

/**
 * Pagination links for prev/next navigation
 */
export interface PaginationLinks {
  prev: SidebarLink | undefined
  next: SidebarLink | undefined
}

/**
 * Turn the nested tree structure of a sidebar into a flat list of all the links.
 */
export function flattenSidebar(sidebar: SidebarEntry[]): SidebarLink[] {
  return sidebar.flatMap((entry) => (entry.type === 'group' ? flattenSidebar(entry.entries) : entry))
}

/**
 * Get previous/next pages in the sidebar based on the current page.
 * Optionally accepts a map of href -> page title to override sidebar labels with actual page titles.
 */
export function getPrevNextLinks(sidebar: SidebarEntry[], titlesByHref?: Map<string, string>): PaginationLinks {
  const entries = flattenSidebar(sidebar)
  const currentIndex = entries.findIndex((entry) => entry.isCurrent)
  let prev = currentIndex > 0 ? entries[currentIndex - 1] : undefined
  let next = currentIndex > -1 && currentIndex < entries.length - 1 ? entries[currentIndex + 1] : undefined

  if (titlesByHref) {
    if (prev) {
      const title = titlesByHref.get(prev.href)
      if (title) prev = { ...prev, label: title }
    }
    if (next) {
      const title = titlesByHref.get(next.href)
      if (title) next = { ...next, label: title }
    }
  }

  return { prev, next }
}
