import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data'
import { getCollection } from 'astro:content'
import {
  buildPythonApiSidebar,
  buildTypeScriptApiSidebar,
  buildCourseSidebar,
  getPrevNextLinks,
  type DocInfo,
} from './dynamic-sidebar'
import { pathWithBase } from './util/links'
import { navLinks, type NavLink } from './config/navbar'
import { isNew, NEW_BADGE } from './util/new-badge'
import { buildIntegrationsSidebar } from './util/integrations-sidebar'

type SidebarEntry = StarlightRouteData['sidebar'][number]
type SidebarGroup = Extract<SidebarEntry, { type: 'group' }>

function isSidebarGroup(entry: SidebarEntry): entry is SidebarGroup {
  return entry.type === 'group'
}

/**
 * Find which nav section the current page belongs to based on URL path.
 * Matches the most specific basePath (longest match wins).
 * Also checks additionalBasePaths for nav items that span multiple sections.
 */
export function findCurrentNavSection(currentPath: string, links: NavLink[]): NavLink | undefined {
  let bestMatch: NavLink | undefined
  let bestMatchLength = 0

  for (const link of links) {
    if (link.external) continue
    const basePaths = link.basePath ? (Array.isArray(link.basePath) ? link.basePath : [link.basePath]) : [link.href]
    for (const bp of basePaths) {
      if (currentPath.startsWith(bp) && bp.length > bestMatchLength) {
        bestMatch = link
        bestMatchLength = bp.length
      }
    }
  }

  return bestMatch
}

/**
 * Filter sidebar entries to only include items matching one or more base paths.
 * If the result is a single top-level group, unwrap it to return just its entries.
 */
export function filterSidebarByBasePath(entries: SidebarEntry[], basePath: string | string[]): SidebarEntry[] {
  const basePaths = Array.isArray(basePath) ? basePath : [basePath]

  const matchesAnyBase = (href: string) => basePaths.some((bp) => href.startsWith(bp))
  const isExternal = (href: string) => /^https?:\/\//.test(href)

  // Whether this level has any base-path match (directly or in a subgroup).
  // External links (a project repo, say) never match a docs base path; they ride
  // along only when a sibling anchors this level, so they can't keep an unrelated
  // group alive in every section.
  const hasBaseMatch = (items: SidebarEntry[]): boolean =>
    items.some((e) =>
      e.type === 'link' ? matchesAnyBase(e.href) : e.type === 'group' ? hasBaseMatch(e.entries) : false,
    )
  const anchored = hasBaseMatch(entries)

  const filtered = entries
    .map((entry) => {
      if (entry.type === 'link') {
        return matchesAnyBase(entry.href) || (anchored && isExternal(entry.href)) ? entry : null
      }
      if (entry.type === 'group') {
        const filteredEntries = filterSidebarByBasePath(entry.entries, basePaths)
        return filteredEntries.length > 0 ? { ...entry, entries: filteredEntries } : null
      }
      return null
    })
    .filter((entry): entry is SidebarEntry => entry !== null)

  // If we have a single top-level group, unwrap it to show its entries directly
  const firstEntry = filtered[0]
  if (filtered.length === 1 && firstEntry && isSidebarGroup(firstEntry)) {
    return firstEntry.entries
  }

  return filtered
}

/**
 * Apply collapse behavior to all sidebar groups.
 * Starlight normalizes all unset collapsed values to false before the middleware
 * runs, making collapsed: false indistinguishable from "not set". Only an explicit
 * collapsed: true in navigation.yml can override the depth-based default.
 */
export function applyCollapse(items: SidebarEntry[], depth: number = 0): SidebarEntry[] {
  return items.map((item) => {
    if (item.type === 'group') {
      const collapsed = item.collapsed === true ? true : depth >= 1
      return { ...item, collapsed, entries: applyCollapse(item.entries, depth + 1) }
    }
    return item
  })
}

/**
 * Add a "New" badge to sidebar links whose page is within the new-badge window.
 * An explicit badge from frontmatter (e.g. Experimental) wins over the derived one.
 */
export function applyNewBadges(items: SidebarEntry[], newHrefs: Set<string>): SidebarEntry[] {
  if (newHrefs.size === 0) return items
  return items.map((item) => {
    if (item.type === 'group') {
      return { ...item, entries: applyNewBadges(item.entries, newHrefs) }
    }
    if (item.badge === undefined && newHrefs.has(item.href)) {
      return { ...item, badge: NEW_BADGE }
    }
    return item
  })
}

/**
 * Collect hrefs of docs pages whose frontmatter addedDate falls within the
 * new-badge window at build time.
 */
async function buildNewPageHrefs(buildDate: Date): Promise<Set<string>> {
  const docs = await getCollection('docs')
  const hrefs = new Set<string>()
  for (const doc of docs) {
    const addedDate = doc.data.addedDate as Date | undefined
    if (addedDate && isNew(addedDate, buildDate)) {
      hrefs.add(pathWithBase(`/${doc.id}/`))
    }
  }
  return hrefs
}

async function loadDocInfos(): Promise<DocInfo[]> {
  const docs = await getCollection('docs')
  return docs.map((doc: { id: string; data: { title: unknown; category?: unknown } }) => ({
    id: doc.id,
    title: doc.data.title as string,
    category: doc.data.category as string | undefined,
  }))
}

async function buildTitlesByHref(): Promise<Map<string, string>> {
  const docs = await getCollection('docs')
  const map = new Map<string, string>()
  for (const doc of docs) {
    if (doc.data.title) {
      map.set(pathWithBase(`/${doc.id}/`), doc.data.title as string)
    }
  }
  return map
}

export const onRequest = defineRouteMiddleware(async (context) => {
  const { starlightRoute } = context.locals
  const { sidebar } = starlightRoute
  const currentPath = context.url.pathname
  const currentSlug = starlightRoute.id

  // "Add Your Integration" renders inside the /integrations catalog rail (its own
  // browse sidebar) rather than sidebar-less, so it reads as part of that section.
  if (currentSlug === 'docs/integrations/get-featured') {
    starlightRoute.sidebar = applyCollapse(await buildIntegrationsSidebar(currentSlug))
    starlightRoute.pagination = { prev: undefined, next: undefined }
    return
  }

  // Integration pages hide the sidebar so they render at Starlight's sidebar-less width.
  if (currentSlug === 'docs/integrations' || currentSlug.startsWith('docs/integrations/')) {
    starlightRoute.hasSidebar = false
    starlightRoute.sidebar = []
    starlightRoute.pagination = { prev: undefined, next: undefined }
    return
  }

  // Examples read as a self-contained gallery — hide the sidebar (overview and
  // every example page) so they render full-width like the integrations page.
  if (currentSlug === 'docs/examples' || currentSlug.startsWith('docs/examples/')) {
    starlightRoute.hasSidebar = false
    starlightRoute.sidebar = []
    starlightRoute.pagination = { prev: undefined, next: undefined }
    return
  }

  // The /integrations/ catalog page supplies its own sidebar: a single group of
  // type filters. Keep that group intact (skipping the base-path filter that
  // would otherwise unwrap a lone top-level group into headerless links) so it
  // renders with a section header and indented items like the product rails.
  if (currentPath === pathWithBase('/integrations/')) {
    starlightRoute.sidebar = applyCollapse(sidebar)
    starlightRoute.pagination = { prev: undefined, next: undefined }
    return
  }

  if (currentSlug.startsWith('docs/api/python') || currentSlug.startsWith('docs/api/typescript')) {
    const docInfos = await loadDocInfos()

    const isPython = currentSlug.startsWith('docs/api/python')
    const apiSidebar = isPython
      ? buildPythonApiSidebar(docInfos, currentSlug)
      : buildTypeScriptApiSidebar(docInfos, currentSlug)

    const overviewHref = isPython ? '/docs/api/python/' : '/docs/api/typescript/'
    const overviewSlug = isPython ? 'docs/api/python' : 'docs/api/typescript'
    apiSidebar.unshift({
      type: 'link',
      label: 'Overview',
      href: pathWithBase(overviewHref),
      isCurrent: currentSlug === overviewSlug,
      badge: undefined,
      attrs: {},
    })

    const titlesByHref = await buildTitlesByHref()
    starlightRoute.sidebar = apiSidebar
    starlightRoute.pagination = getPrevNextLinks(apiSidebar, titlesByHref)
    return
  }

  if (currentSlug.startsWith('docs/learning/')) {
    const courses = await getCollection('courses')
    // YAML hrefs are site-relative — compare raw slug, not pathWithBase.
    const currentHref = `/${currentSlug}/`

    const matchedCourse = courses
      .map((entry) => entry.data)
      .find((course) => course.lessons?.some((lesson) => lesson.href === currentHref))

    if (matchedCourse) {
      const docInfos = await loadDocInfos()
      const lessonIds = (matchedCourse.lessons ?? []).map((lesson) => lesson.href.replace(/^\/|\/$/g, ''))

      const courseSidebar = buildCourseSidebar(docInfos, currentSlug, {
        title: matchedCourse.title,
        lessonIds,
      })

      const lessonGroup = courseSidebar.find((entry) => entry.type === 'group')
      const lessonsOnly: SidebarEntry[] = lessonGroup?.type === 'group' ? lessonGroup.entries : []
      const titlesByHref = await buildTitlesByHref()

      starlightRoute.sidebar = courseSidebar
      starlightRoute.pagination = getPrevNextLinks(lessonsOnly, titlesByHref)
      return
    }
  }

  const currentNav = findCurrentNavSection(currentPath, navLinks)

  // If no matching nav section, show empty sidebar
  if (!currentNav || currentNav.label == 'Home') {
    starlightRoute.sidebar = []
    return
  }

  const bp = currentNav.basePath || currentNav.href
  const allBasePaths = Array.isArray(bp) ? bp : [bp]

  // Otherwise filter it down to the major section that we're in. The scoped
  // result renders as the left sidebar (Starlight's normal rail).
  const filteredSidebar = filterSidebarByBasePath(sidebar, allBasePaths)
  starlightRoute.sidebar = applyNewBadges(applyCollapse(filteredSidebar), await buildNewPageHrefs(new Date()))

  // Starlight pre-computes pagination before middleware; prune links outside the current nav section.
  const matchesAnyBase = (href: string) => allBasePaths.some((bp) => href.startsWith(bp))
  const titlesByHref = await buildTitlesByHref()
  const { prev, next } = starlightRoute.pagination
  starlightRoute.pagination = {
    prev: prev && matchesAnyBase(prev.href) ? { ...prev, label: titlesByHref.get(prev.href) ?? prev.label } : undefined,
    next: next && matchesAnyBase(next.href) ? { ...next, label: titlesByHref.get(next.href) ?? next.label } : undefined,
  }
})
