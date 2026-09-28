import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  findCurrentNavSection,
  filterSidebarByBasePath,
  applyCollapse,
  onRequest,
} from '../src/route-middleware'
import { type NavLink } from '../src/config/navbar'
import { loadSidebarFromConfig, type StarlightSidebarItem } from '../src/sidebar'
import { buildCourseSidebar, getPrevNextLinks, type DocInfo } from '../src/dynamic-sidebar'

// Sidebar entry types matching Starlight's runtime structure
type SidebarLink = { type: 'link'; label: string; href: string; isCurrent: boolean }
type SidebarGroup = { type: 'group'; label: string; entries: SidebarEntry[]; collapsed: boolean }
type SidebarEntry = SidebarLink | SidebarGroup

// Test nav links without base path (simulating no BASE_URL set)
const testNavLinks: NavLink[] = [
  { label: 'Home', href: '/' },
  { label: 'User Guide', href: '/docs/user-guide/quickstart/overview/', basePath: '/docs/user-guide/' },
  { label: 'Examples', href: '/docs/examples/', basePath: '/docs/examples/' },
  { label: 'Integrations', href: '/integrations/', basePath: ['/integrations/', '/docs/integrations/'] },
  { label: 'Contribute', href: 'https://github.com/example', external: true },
]

function convertToRuntimeFormat(items: StarlightSidebarItem[]): SidebarEntry[] {
  return items.map((item) => {
    if ('slug' in item) {
      return {
        type: 'link' as const,
        label: item.label || item.slug,
        href: '/' + item.slug + '/',
        isCurrent: false,
      }
    }
    if ('link' in item) {
      return {
        type: 'link' as const,
        label: item.label,
        href: item.link,
        isCurrent: false,
      }
    }
    if ('items' in item) {
      return {
        type: 'group' as const,
        label: item.label,
        entries: convertToRuntimeFormat(item.items),
        collapsed: item.collapsed ?? false,
      }
    }
    throw new Error('Unknown sidebar item type')
  })
}

// Helper to extract all links from sidebar structure
function getAllLinks(entries: SidebarEntry[]): SidebarLink[] {
  const links: SidebarLink[] = []
  for (const entry of entries) {
    if (entry.type === 'link') {
      links.push(entry)
    } else if (entry.type === 'group') {
      links.push(...getAllLinks(entry.entries))
    }
  }
  return links
}

describe('findCurrentNavSection', () => {
  it('should find Examples nav for /examples/ path', () => {
    const result = findCurrentNavSection('/docs/examples/', testNavLinks)
    expect(result).toBeDefined()
    expect(result?.label).toBe('Examples')
  })

  it('should find Examples nav for nested examples path', () => {
    const result = findCurrentNavSection('/docs/examples/python/weather_forecaster/', testNavLinks)
    expect(result).toBeDefined()
    expect(result?.label).toBe('Examples')
  })

  it('should find User Guide nav for user-guide paths', () => {
    const result = findCurrentNavSection('/docs/user-guide/quickstart/overview/', testNavLinks)
    expect(result).toBeDefined()
    expect(result?.label).toBe('User Guide')
  })

  it('should find Integrations nav for integrations docs paths', () => {
    const result = findCurrentNavSection('/docs/integrations/get-featured/', testNavLinks)
    expect(result).toBeDefined()
    expect(result?.label).toBe('Integrations')
  })

  it('should find Home nav for root path', () => {
    const result = findCurrentNavSection('/', testNavLinks)
    expect(result).toBeDefined()
    expect(result?.label).toBe('Home')
  })

  it('should not match external links', () => {
    const externalOnlyLinks: NavLink[] = [
      { label: 'Contribute', href: 'https://github.com/example', external: true },
    ]
    const result = findCurrentNavSection('/anything/', externalOnlyLinks)
    expect(result).toBeUndefined()
  })

  it('should work with base path in nav links', () => {
    const navWithBase: NavLink[] = [
      { label: 'Home', href: '/docs/' },
      { label: 'Examples', href: '/docs/examples/', basePath: '/docs/examples/' },
    ]
    const result = findCurrentNavSection('/docs/examples/python/', navWithBase)
    expect(result).toBeDefined()
    expect(result?.label).toBe('Examples')
  })
})

describe('Sidebar filtering with live navigation.yml data', () => {
  const configPath = path.resolve('./src/config/navigation.yml')
  const docsDir = path.resolve('./src/content')
  const buildTimeSidebar = loadSidebarFromConfig(configPath, docsDir)
  const runtimeSidebar = convertToRuntimeFormat(buildTimeSidebar)

  it('should have loaded sidebar from navigation.yml', () => {
    expect(runtimeSidebar.length).toBeGreaterThan(0)
    console.log(`\nLoaded ${runtimeSidebar.length} top-level sidebar items`)
  })

  it('has no doc-sidebar section for examples (standalone /examples/ catalog)', () => {
    // Examples is a standalone /examples/ catalog page, not a filtered doc sidebar.
    const result = filterSidebarByBasePath(runtimeSidebar as any, '/docs/examples/')
    expect(getAllLinks(result)).toHaveLength(0)
  })

  it('should filter sidebar to only User Guide items for /user-guide/ basePath', () => {
    const result = filterSidebarByBasePath(runtimeSidebar as any, '/docs/user-guide/')

    const allLinks = getAllLinks(result)
    console.log(`\nUser Guide section has ${allLinks.length} links`)

    expect(allLinks.length).toBeGreaterThan(0)
    allLinks.forEach((link) => {
      expect(link.href).toMatch(/^\/docs\/user-guide\//)
    })
  })

  it('has no doc-sidebar section for integrations (dynamic catalog sidebar)', () => {
    // Integrations pages build their rail from the catalog collection
    // (src/util/integrations-sidebar.ts), not from navigation.yml.
    const result = filterSidebarByBasePath(runtimeSidebar as any, '/docs/integrations/')
    expect(getAllLinks(result)).toHaveLength(0)
  })

})

describe('Integration: Full filtering flow', () => {
  const configPath = path.resolve('./src/config/navigation.yml')
  const docsDir = path.resolve('./src/content')
  const buildTimeSidebar = loadSidebarFromConfig(configPath, docsDir)
  const runtimeSidebar = convertToRuntimeFormat(buildTimeSidebar)

  it('resolves integrations docs pages to the Integrations nav section with an empty yml sidebar', () => {
    // The Integrations section owns /docs/integrations/, but its rail is built
    // dynamically from the catalog (see buildIntegrationsSidebar), so the
    // navigation.yml-derived sidebar is expected to contribute nothing here.
    const currentPath = '/docs/integrations/get-featured/'
    const currentNav = findCurrentNavSection(currentPath, testNavLinks)

    expect(currentNav).toBeDefined()
    expect(currentNav?.label).toBe('Integrations')

    const basePath = currentNav?.basePath || currentNav?.href || ''
    const filtered = filterSidebarByBasePath(runtimeSidebar as any, basePath)
    const result = applyCollapse(filtered)

    expect(getAllLinks(result)).toHaveLength(0)
  })

  it('lesson pagination prev is the previous lesson, not the All-courses back-link', () => {
    // Mirrors the middleware's lesson branch: sidebar from buildCourseSidebar,
    // pagination from the lesson group's entries only.
    const lessonIds = [
      'docs/learning/how-agents-really-work',
      'docs/learning/switching-model-providers',
      'docs/learning/give-your-agent-tools-using-mcp',
    ]
    const lessonDocs: DocInfo[] = [
      { id: 'docs/learning/how-agents-really-work', title: 'Lesson 1: How Agents Really Work' },
      { id: 'docs/learning/switching-model-providers', title: 'Lesson 2: Switching Model Providers' },
      { id: 'docs/learning/give-your-agent-tools-using-mcp', title: 'Lesson 3: Give Your Agent Tools Using MCP' },
    ]
    const currentSlug = 'docs/learning/switching-model-providers'
    const course = { title: 'Agent Fundamentals with Strands', lessonIds }
    const courseSidebar = buildCourseSidebar(lessonDocs, currentSlug, course)

    expect(courseSidebar[0]?.type).toBe('group')

    const lessonGroup = courseSidebar.find((entry) => entry.type === 'group')
    const lessonsOnly = lessonGroup?.type === 'group' ? lessonGroup.entries : []
    const { prev, next } = getPrevNextLinks(lessonsOnly)

    expect(prev?.label).toBe('Lesson 1: How Agents Really Work')
    expect(prev?.label).not.toBe('← Course start')
    expect(next?.label).toBe('Lesson 3: Give Your Agent Tools Using MCP')
  })
})

describe('applyCollapse', () => {
  it('should keep top-level groups expanded by default', () => {
    const input: SidebarEntry[] = [
      { type: 'group', label: 'Group 1', collapsed: false, entries: [] },
      { type: 'group', label: 'Group 2', collapsed: false, entries: [] },
    ]

    const result = applyCollapse(input as any)

    expect((result[0] as SidebarGroup).collapsed).toBe(false)
    expect((result[1] as SidebarGroup).collapsed).toBe(false)
  })

  it('should respect explicit collapsed: true at top level', () => {
    const input: SidebarEntry[] = [
      { type: 'group', label: 'Group 1', collapsed: true, entries: [] },
      { type: 'group', label: 'Group 2', collapsed: false, entries: [] },
    ]

    const result = applyCollapse(input as any)

    expect((result[0] as SidebarGroup).collapsed).toBe(true)
    expect((result[1] as SidebarGroup).collapsed).toBe(false)
  })

  it('should collapse nested groups by default when no explicit value', () => {
    // Starlight pre-normalizes unset collapsed to false; this path (missing property) only runs outside Starlight.
    const nested = { type: 'group' as const, label: 'Nested', entries: [] }
    const input = [{ type: 'group' as const, label: 'Top', entries: [nested] }]

    const result = applyCollapse(input as any)

    const top = result[0] as SidebarGroup
    expect(top.collapsed).toBe(false)
    expect((top.entries[0] as SidebarGroup).collapsed).toBe(true)
  })

  it('should collapse nested groups when Starlight has normalized collapsed to false', () => {
    // Starlight normalizes unset collapsed to false; depth-based default still applies.
    const nested: SidebarGroup = { type: 'group', label: 'Nested', collapsed: false, entries: [] }
    const input: SidebarEntry[] = [{ type: 'group', label: 'Top', collapsed: false, entries: [nested] }]

    const result = applyCollapse(input as any)

    const top = result[0] as SidebarGroup
    expect(top.collapsed).toBe(false)
    expect((top.entries[0] as SidebarGroup).collapsed).toBe(true)
  })

  it('should not modify links', () => {
    const input: SidebarEntry[] = [{ type: 'link', label: 'Link', href: '/link/', isCurrent: false }]

    const result = applyCollapse(input as any)

    expect(result[0]!.type).toBe('link')
    expect((result[0] as SidebarLink).href).toBe('/link/')
  })
})

describe('filterSidebarByBasePath unwrapping', () => {
  it('should unwrap single top-level group to show its entries directly', () => {
    const sidebar: SidebarEntry[] = [
      {
        type: 'group',
        label: 'Examples',
        collapsed: false,
        entries: [
          { type: 'link', label: 'Overview', href: '/examples/', isCurrent: false },
          { type: 'link', label: 'Weather', href: '/examples/weather/', isCurrent: false },
        ],
      },
      {
        type: 'group',
        label: 'User Guide',
        collapsed: false,
        entries: [
          { type: 'link', label: 'Quickstart', href: '/user-guide/quickstart/', isCurrent: false },
        ],
      },
    ]

    const result = filterSidebarByBasePath(sidebar as any, '/examples/')

    // Should unwrap the single "Examples" group and return its entries directly
    expect(result.length).toBe(2)
    expect(result[0]!.type).toBe('link')
    expect((result[0] as SidebarLink).href).toBe('/examples/')
    expect((result[1] as SidebarLink).href).toBe('/examples/weather/')
  })

  it('should not unwrap when multiple top-level items match', () => {
    const sidebar: SidebarEntry[] = [
      { type: 'link', label: 'Examples Home', href: '/examples/', isCurrent: false },
      {
        type: 'group',
        label: 'Python Examples',
        collapsed: false,
        entries: [
          { type: 'link', label: 'Weather', href: '/examples/python/weather/', isCurrent: false },
        ],
      },
    ]

    const result = filterSidebarByBasePath(sidebar as any, '/examples/')

    // Should keep both items since there are multiple matches
    expect(result.length).toBe(2)
    expect(result[0]!.type).toBe('link')
    expect(result[1]!.type).toBe('group')
  })

  it('should not unwrap a single top-level link', () => {
    const sidebar: SidebarEntry[] = [
      { type: 'link', label: 'Examples', href: '/examples/', isCurrent: false },
      { type: 'link', label: 'Other', href: '/other/', isCurrent: false },
    ]

    const result = filterSidebarByBasePath(sidebar as any, '/examples/')

    // Single link should remain as-is
    expect(result.length).toBe(1)
    expect(result[0]!.type).toBe('link')
  })
})

describe('filterSidebarByBasePath with base path in URLs', () => {
  it('should filter sidebar entries that include base path', () => {
    const sidebar: SidebarEntry[] = [
      { type: 'link', label: 'Examples', href: '/docs/examples/', isCurrent: false },
      { type: 'link', label: 'User Guide', href: '/docs/user-guide/', isCurrent: false },
    ]

    // When base path is /docs, nav basePath would be /docs/examples/
    const result = filterSidebarByBasePath(sidebar as any, '/docs/examples/')

    expect(result.length).toBe(1)
    expect((result[0] as SidebarLink).href).toBe('/docs/examples/')
  })

  it('should handle nested groups with base path', () => {
    const sidebar: SidebarEntry[] = [
      {
        type: 'group',
        label: 'Examples',
        collapsed: false,
        entries: [
          { type: 'link', label: 'Overview', href: '/docs/examples/', isCurrent: false },
          { type: 'link', label: 'Python', href: '/docs/examples/python/', isCurrent: false },
        ],
      },
      {
        type: 'group',
        label: 'User Guide',
        collapsed: false,
        entries: [
          { type: 'link', label: 'Quickstart', href: '/docs/user-guide/quickstart/', isCurrent: false },
        ],
      },
    ]

    const result = filterSidebarByBasePath(sidebar as any, '/docs/examples/')

    // Should unwrap single matching group
    expect(result.length).toBe(2)
    expect((result[0] as SidebarLink).href).toBe('/docs/examples/')
    expect((result[1] as SidebarLink).href).toBe('/docs/examples/python/')
  })
})

describe('onRequest integration: lesson pagination via real collection', () => {
  it('lesson1 has no prev — back-link must not appear as prev', async () => {
    // Guards lessonsOnly: back-link is the entry preceding lesson1 in the full sidebar;
    // passing the full sidebar to getPrevNextLinks would make it lesson1's prev.
    const currentSlug = 'docs/learning/how-agents-really-work'

    const starlightRoute: Record<string, unknown> = {
      id: currentSlug,
      sidebar: [],
      hasSidebar: true,
      pagination: { prev: undefined, next: undefined },
    }

    const context = {
      locals: { starlightRoute },
      url: new URL(`https://example.com/${currentSlug}/`),
    }

    const noopNext = async (): Promise<void> => {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await onRequest(context as any, noopNext)

    const sidebar = starlightRoute.sidebar as SidebarEntry[]
    expect(sidebar[0]?.type).toBe('group')

    const pagination = starlightRoute.pagination as { prev?: SidebarLink; next?: SidebarLink }
    expect(pagination.prev).toBeUndefined()
    expect(pagination.next?.label).toBe('Lesson 2: Switching Model Providers')
  })
})
