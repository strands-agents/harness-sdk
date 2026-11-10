import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isNew, NEW_BADGE, NEW_BADGE_DAYS } from '../src/util/new-badge'
import { applyNewBadges } from '../src/route-middleware'
import { loadSidebarFromConfig } from '../src/sidebar'

const BUILD_DATE = new Date('2026-08-13T00:00:00Z')

function daysBefore(days: number): Date {
  return new Date(BUILD_DATE.getTime() - days * 86_400_000)
}

describe('isNew', () => {
  it('is true within the window and false at its edge', () => {
    expect(isNew(BUILD_DATE, BUILD_DATE)).toBe(true)
    expect(isNew(daysBefore(NEW_BADGE_DAYS - 1), BUILD_DATE)).toBe(true)
    expect(isNew(daysBefore(NEW_BADGE_DAYS), BUILD_DATE)).toBe(false)
  })

  it('is false for a future date', () => {
    expect(isNew(daysBefore(-1), BUILD_DATE)).toBe(false)
  })
})

describe('applyNewBadges', () => {
  const link = (href: string, badge?: { text: string; variant: string }) =>
    ({ type: 'link', label: href, href, isCurrent: false, badge, attrs: {} }) as never

  const group = (entries: never[]) =>
    ({ type: 'group', label: 'g', entries, collapsed: false, badge: undefined }) as never

  it('adds a New badge to links in the set, including inside groups', () => {
    const sidebar = applyNewBadges([link('/a/'), group([link('/b/')])], new Set(['/b/']))
    expect((sidebar[0] as { badge?: unknown }).badge).toBeUndefined()
    const nested = (sidebar[1] as { entries: { badge?: unknown }[] }).entries[0]
    expect(nested.badge).toEqual(NEW_BADGE)
  })

  it('keeps an explicit badge over the derived one', () => {
    const explicit = { text: 'Experimental', variant: 'caution' }
    const sidebar = applyNewBadges([link('/a/', explicit)], new Set(['/a/']))
    expect((sidebar[0] as { badge?: unknown }).badge).toEqual(explicit)
  })
})

describe('sidebar group addedDate', () => {
  function loadFixtureSidebar(...groupFields: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-'))
    const configPath = path.join(dir, 'navigation.yml')
    fs.writeFileSync(
      configPath,
      [
        'sidebar:',
        '  - label: Fresh',
        ...groupFields.map((field) => `    ${field}`),
        '    items:',
        '      - docs/example-page',
      ].join('\n')
    )
    return loadSidebarFromConfig(configPath, undefined, BUILD_DATE)
  }

  const added = (days: number) => `addedDate: ${daysBefore(days).toISOString().slice(0, 10)}`

  it('derives a New badge inside the window and none outside it', () => {
    expect(loadFixtureSidebar(added(1))[0]).toMatchObject({ badge: NEW_BADGE })
    expect(loadFixtureSidebar(added(NEW_BADGE_DAYS + 1))[0]).not.toHaveProperty('badge')
  })

  it('derives no badge for a future addedDate', () => {
    expect(loadFixtureSidebar(added(-1))[0]).not.toHaveProperty('badge')
  })

  it('keeps an explicit group badge over the derived one', () => {
    expect(loadFixtureSidebar('badge: Preview', added(1))[0]).toMatchObject({ badge: 'Preview' })
  })
})

describe('no hand-written New badges', () => {
  const docsDir = path.resolve('./src/content/docs')

  function walkAuthoredDocs(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) return []
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walkAuthoredDocs(full)
      return /\.mdx?$/.test(entry.name) ? [full] : []
    })
  }

  function frontmatter(file: string): string {
    const match = fs.readFileSync(file, 'utf-8').match(/^---\n([\s\S]*?)\n---/)
    return match ? match[1] : ''
  }

  it('docs frontmatter uses addedDate, never a literal New badge', () => {
    const offenders = walkAuthoredDocs(docsDir).filter((f) => /text:\s*['"]?New['"]?\s*$/m.test(frontmatter(f)))
    expect(offenders, 'set addedDate in frontmatter instead of a literal New badge').toEqual([])
  })

  it('navigation.yml uses addedDate, never a literal New badge', () => {
    const nav = fs.readFileSync(path.resolve('./src/config/navigation.yml'), 'utf-8')
    expect(/text:\s*['"]?New['"]?\s*$/m.test(nav), 'set addedDate on the group instead of a literal New badge').toBe(
      false
    )
  })
})
