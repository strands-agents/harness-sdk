import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import yaml from 'js-yaml'
import { loadSidebarFromConfig, type StarlightSidebarItem } from '../src/sidebar'
import { pathToDocsSlug } from '../src/util/links'

// Same first-fence frontmatter read as redirect.static.ts; only `slug` matters here.
function frontmatterSlug(filePath: string): unknown {
  const match = readFileSync(filePath, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const parsed = match ? yaml.load(match[1] ?? '') : undefined
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).slug : undefined
}

describe('Content Collections', () => {
  it('should list all doc contents', async () => {
    const docs = await getCollection('docs')

    console.log('\n=== All Docs ===\n')
    console.log(`Total: ${docs.length} documents\n`)

    for (const doc of docs) {
      console.log(`- ${doc.id}`)
      console.log(`  Title: ${doc.data.title}`)
      if (doc.data.languages) console.log(`  Languages: ${doc.data.languages}`)
      if (doc.data.community) console.log(`  Community: ${doc.data.community}`)
      if (doc.data.experimental) console.log(`  Experimental: ${doc.data.experimental}`)
    }

    expect(docs.length).toBeGreaterThan(0)
  })

  it('loads every hand-authored content file on disk', async () => {
    // The collection's glob patterns match .mdx only and carve out filenames
    // with a [!index] character class; a file they miss never renders and
    // nothing reports it. Generated API docs are owned by their generator.
    const docs = await getCollection('docs')
    const ids = new Set(docs.map((doc) => doc.id))
    const files = fg.sync(['404.mdx', 'docs/{user-guide,integrations,contribute,examples,labs}/**/*.{md,mdx}'], {
      cwd: 'src/content',
      followSymbolicLinks: false,
    })
    const dropped = files.filter((file) => {
      // examples index pages are excluded by design (see content.config.ts)
      if (file.startsWith('docs/examples/') && /^index\.mdx?$/.test(path.basename(file))) return false
      return !ids.has(pathToDocsSlug(file, frontmatterSlug(path.join('src/content', file))))
    })
    expect(dropped).toEqual([])
  })

  it('should have valid slugs for all sidebar items', async () => {
    const configPath = path.resolve('./src/config/navigation.yml')
    const docsDir = path.resolve('./docs')
    const sidebar = loadSidebarFromConfig(configPath, docsDir)
    const docs = await getCollection('docs')

    // Build a set of valid doc IDs
    const validIds = new Set(docs.map((doc) => doc.id))

    // Extract all slugs from the sidebar
    function extractSlugs(items: StarlightSidebarItem[]): string[] {
      const slugs: string[] = []
      for (const item of items) {
        if ('slug' in item && item.slug) {
          slugs.push(item.slug)
        }
        if ('items' in item) {
          slugs.push(...extractSlugs(item.items))
        }
      }
      return slugs
    }

    const slugs = extractSlugs(sidebar)

    const invalidSlugs: string[] = []
    for (const slug of slugs) {
      if (!validIds.has(slug)) {
        invalidSlugs.push(slug)
      }
    }

    if (invalidSlugs.length > 0) {
      console.log('\n=== Invalid Sidebar Slugs (no content entry found) ===\n')
      for (const slug of invalidSlugs) {
        console.log(`- ${slug}`)
      }
    }

    expect(invalidSlugs).toEqual([])
  })

  it('has unique titles across user-guide pages', async () => {
    // Related-pages output and JSON-LD `headline` use `title` verbatim. Two
    // user-guide pages with the same title produce ambiguous links that look
    // like duplicates. Intentional shared titles are allowlisted below.
    // Set `sidebar.label` if you want the sidebar to stay terse while the page
    // title remains unambiguous out-of-context.
    const docs = await getCollection('docs')
    const userGuide = docs.filter((d) => d.id.startsWith('docs/user-guide/'))

    const titleMap = new Map<string, string[]>()
    for (const doc of userGuide) {
      const slugs = titleMap.get(doc.data.title) ?? []
      slugs.push(doc.id)
      titleMap.set(doc.data.title, slugs)
    }

    const allowedDuplicates = new Set(['Hooks', 'Interrupts', 'Steering'])
    const collisions = [...titleMap.entries()].filter(
      ([title, slugs]) => slugs.length > 1 && !allowedDuplicates.has(title)
    )
    if (collisions.length > 0) {
      console.log('\n=== Duplicate user-guide titles ===\n')
      for (const [title, slugs] of collisions) {
        console.log(`"${title}"`)
        for (const s of slugs) console.log(`  ${s}`)
      }
    }

    expect(collisions).toEqual([])
  })
})
