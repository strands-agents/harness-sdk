import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import {
  buildPythonApiSidebar,
  buildCourseSidebar,
  getPrevNextLinks,
  getDisplayName,
  type DocInfo,
  type SidebarEntry,
  type SidebarGroup,
  type SidebarLink,
} from '../src/dynamic-sidebar'

describe('getDisplayName', () => {
  it('should capitalize single words', () => {
    expect(getDisplayName('agent')).toBe('Agent')
  })

  it('should convert snake_case to Title Case', () => {
    expect(getDisplayName('model_provider')).toBe('Model Provider')
  })

  it('should handle multiple underscores', () => {
    expect(getDisplayName('bidi_types_events')).toBe('Bidi Types Events')
  })
})

describe('buildPythonApiSidebar', () => {
  it('should create flat links for leaf modules', () => {
    const docs: DocInfo[] = [
      { id: 'docs/api/python/strands.interrupt.mdx', title: 'strands.interrupt' },
    ]

    const sidebar = buildPythonApiSidebar(docs, '')

    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]).toMatchObject({
      type: 'link',
      label: 'Interrupt',
      href: '/docs/api/python/strands.interrupt.mdx/',
    })
  })

  it('should group modules by path segments', () => {
    const docs: DocInfo[] = [
      { id: 'docs/api/python/strands.agent.agent.mdx', title: 'strands.agent.agent' },
      { id: 'docs/api/python/strands.agent.base.mdx', title: 'strands.agent.base' },
    ]

    const sidebar = buildPythonApiSidebar(docs, '')

    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]?.type).toBe('group')
    expect(sidebar[0]?.label).toBe('Agent')

    const group = sidebar[0] as Extract<SidebarEntry, { type: 'group' }>
    expect(group.entries).toHaveLength(2)
    expect(group.entries.map((e) => e.label)).toContain('Agent')
    expect(group.entries.map((e) => e.label)).toContain('Base')
  })

  it('should create nested groups for deep module paths', () => {
    const docs: DocInfo[] = [
      { id: 'docs/api/python/strands.experimental.bidi.types.mdx', title: 'strands.experimental.bidi.types' },
      { id: 'docs/api/python/strands.experimental.bidi.models.mdx', title: 'strands.experimental.bidi.models' },
    ]

    const sidebar = buildPythonApiSidebar(docs, '')

    // Should have Experimental group
    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]?.type).toBe('group')
    expect(sidebar[0]?.label).toBe('Experimental')

    const experimental = sidebar[0] as Extract<SidebarEntry, { type: 'group' }>
    const bidi = experimental.entries[0] as Extract<SidebarEntry, { type: 'group' }>
    expect(bidi.label).toBe('Bidi')

    expect(bidi.entries).toHaveLength(2)
    expect(bidi.entries.map((e) => e.label)).toContain('Models')
    expect(bidi.entries.map((e) => e.label)).toContain('Types')
  })

  it('should mark current page as isCurrent', () => {
    const docs: DocInfo[] = [
      { id: 'docs/api/python/strands.interrupt.mdx', title: 'strands.interrupt' },
    ]

    const sidebar = buildPythonApiSidebar(docs, 'docs/api/python/strands.interrupt.mdx')

    const link = sidebar[0] as Extract<SidebarEntry, { type: 'link' }>
    expect(link.isCurrent).toBe(true)
  })

  it('should filter out non-python-api docs', () => {
    const docs: DocInfo[] = [
      { id: 'docs/api/python/strands.agent.agent.mdx', title: 'strands.agent.agent' },
      { id: 'docs/user-guide/quickstart.mdx', title: 'Quickstart' },
      { id: 'docs/api/python/index', title: 'Python API Reference' },
    ]

    const sidebar = buildPythonApiSidebar(docs, '')

    // Should only have the agent group
    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]?.label).toBe('Agent')
  })

  it('should sort groups before links', () => {
    const docs: DocInfo[] = [
      { id: 'docs/api/python/strands.interrupt.mdx', title: 'strands.interrupt' },
      { id: 'docs/api/python/strands.agent.agent.mdx', title: 'strands.agent.agent' },
    ]

    const sidebar = buildPythonApiSidebar(docs, '')

    // Agent group should come before Interrupt link
    expect(sidebar[0]?.type).toBe('group')
    expect(sidebar[0]?.label).toBe('Agent')
    expect(sidebar[1]?.type).toBe('link')
    expect(sidebar[1]?.label).toBe('Interrupt')
  })
})

describe('buildPythonApiSidebar with real collection', () => {
  it('should build sidebar from actual docs collection', async () => {
    const docs = await getCollection('docs')
    const docInfos: DocInfo[] = docs.map((doc) => ({
      id: doc.id,
      title: doc.data.title as string,
    }))

    const sidebar = buildPythonApiSidebar(docInfos, '')

    console.log('\n=== Python API Sidebar Structure ===\n')
    printSidebar(sidebar, 0)

    // Should have at least some entries
    expect(sidebar.length).toBeGreaterThan(0)
  })
})

describe('buildCourseSidebar', () => {
  const COURSE = { title: 'Agent Fundamentals with Strands', lessonIds: [] as string[] }

  function makeDocs(ids: string[]): DocInfo[] {
    return ids.map((id) => ({ id, title: id.split('/').pop()! }))
  }

  it('returns a single group of lesson links (no back-link)', () => {
    const ids = ['docs/learning/alpha', 'docs/learning/beta', 'docs/learning/gamma']
    const docs = makeDocs(ids)
    const course = { ...COURSE, lessonIds: ids }
    const sidebar = buildCourseSidebar(docs, ids[0]!, course)

    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]?.type).toBe('group')
  })

  it('respects array order — lesson 10 after lesson 9 even if passed out of order in docs', () => {
    // Docs provided in non-numeric order; lessonIds defines the order.
    const ids = [
      'docs/learning/lesson-1',
      'docs/learning/lesson-2',
      'docs/learning/lesson-9',
      'docs/learning/lesson-10',
      'docs/learning/lesson-11',
    ]
    const docs: DocInfo[] = [
      { id: 'docs/learning/lesson-10', title: 'Lesson 10' },
      { id: 'docs/learning/lesson-1', title: 'Lesson 1' },
      { id: 'docs/learning/lesson-11', title: 'Lesson 11' },
      { id: 'docs/learning/lesson-9', title: 'Lesson 9' },
      { id: 'docs/learning/lesson-2', title: 'Lesson 2' },
    ]
    const course = { ...COURSE, lessonIds: ids }
    const sidebar = buildCourseSidebar(docs, '', course)

    const group = sidebar[0] as SidebarGroup
    const labels = group.entries.map((e) => e.label)
    expect(labels).toEqual(['Lesson 1', 'Lesson 2', 'Lesson 9', 'Lesson 10', 'Lesson 11'])
  })

  it('marks the current lesson as isCurrent', () => {
    const ids = ['docs/learning/alpha', 'docs/learning/beta', 'docs/learning/gamma']
    const docs = makeDocs(ids)
    const course = { ...COURSE, lessonIds: ids }
    const currentSlug = 'docs/learning/beta'
    const sidebar = buildCourseSidebar(docs, currentSlug, course)

    const group = sidebar[0] as SidebarGroup
    const links = group.entries as SidebarLink[]
    expect(links[0]?.isCurrent).toBe(false)
    expect(links[1]?.isCurrent).toBe(true)
    expect(links[2]?.isCurrent).toBe(false)
  })

  it('excludes ids not in lessonIds (non-course pages under docs/learning/)', () => {
    const docs: DocInfo[] = [
      { id: 'docs/learning/alpha', title: 'Alpha' },
      { id: 'docs/learning/overview', title: 'Overview' },
    ]
    const course = { ...COURSE, lessonIds: ['docs/learning/alpha'] }
    const sidebar = buildCourseSidebar(docs, '', course)

    const group = sidebar[0] as SidebarGroup
    expect(group.entries).toHaveLength(1)
    expect((group.entries[0] as SidebarLink).label).toBe('Alpha')
  })

  it('returns an empty sidebar when zero lessonIds match', () => {
    const docs: DocInfo[] = [{ id: 'docs/learning/overview', title: 'Overview' }]
    const sidebar = buildCourseSidebar(docs, '', { ...COURSE, lessonIds: [] })

    expect(sidebar).toHaveLength(0)
  })

  it('uses course.title as the group label', () => {
    const ids = ['docs/learning/alpha']
    const docs = makeDocs(ids)
    const course = { title: 'My Custom Course', lessonIds: ids }
    const sidebar = buildCourseSidebar(docs, '', course)

    const group = sidebar[0] as SidebarGroup
    expect(group.label).toBe('My Custom Course')
  })
})

describe('getPrevNextLinks over buildCourseSidebar lessons', () => {
  const ids = ['docs/learning/alpha', 'docs/learning/beta', 'docs/learning/gamma']
  const docs: DocInfo[] = [
    { id: 'docs/learning/alpha', title: 'Alpha' },
    { id: 'docs/learning/beta', title: 'Beta' },
    { id: 'docs/learning/gamma', title: 'Gamma' },
  ]
  const course = { title: 'Test Course', lessonIds: ids }

  it('first lesson has no prev and next is the second lesson', () => {
    const sidebar = buildCourseSidebar(docs, 'docs/learning/alpha', course)

    const group = sidebar[0] as SidebarGroup
    const { prev, next } = getPrevNextLinks(group.entries)

    expect(prev).toBeUndefined()
    expect(next?.label).toBe('Beta')
  })

  it('second lesson has prev first and next third', () => {
    const sidebar = buildCourseSidebar(docs, 'docs/learning/beta', course)

    const group = sidebar[0] as SidebarGroup
    const { prev, next } = getPrevNextLinks(group.entries)

    expect(prev?.label).toBe('Alpha')
    expect(next?.label).toBe('Gamma')
  })
})

function printSidebar(entries: SidebarEntry[], indent: number): void {
  const prefix = '  '.repeat(indent)
  for (const entry of entries) {
    if (entry.type === 'link') {
      console.log(`${prefix}- [link] ${entry.label} -> ${entry.href}`)
    } else if (entry.type === 'group') {
      console.log(`${prefix}- [group] ${entry.label}`)
      printSidebar(entry.entries, indent + 1)
    }
  }
}
