import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import {
  isRelativeLink,
  normalizePath,
  resolveRelativeLink,
  findDocSlug,
  resolveHref,
  isApiShorthand,
  resolveApiShorthand,
} from '../src/util/links'

describe('Link Utilities', () => {
  describe('isApiShorthand', () => {
    it('should return true for @api/python links', () => {
      expect(isApiShorthand('@api/python/strands.agent.agent')).toBe(true)
      expect(isApiShorthand('@api/python/strands.agent.agent_result')).toBe(true)
      expect(isApiShorthand('@api/python/strands.models.bedrock')).toBe(true)
    })

    it('should return true for @api/typescript links', () => {
      expect(isApiShorthand('@api/typescript/Agent')).toBe(true)
      expect(isApiShorthand('@api/typescript/BedrockModel')).toBe(true)
    })

    it('should return true for @api links with anchors', () => {
      expect(isApiShorthand('@api/python/strands.agent.agent#Agent')).toBe(true)
      expect(isApiShorthand('@api/typescript/BedrockModel#constructor')).toBe(true)
    })

    it('should return false for non-@api links', () => {
      expect(isApiShorthand('../api-reference/python/agent.md')).toBe(false)
      expect(isApiShorthand('/api/python/strands.agent.agent/')).toBe(false)
      expect(isApiShorthand('https://example.com')).toBe(false)
      expect(isApiShorthand('relative/path.md')).toBe(false)
    })
  })

  describe('resolveApiShorthand', () => {
    it('should resolve Python API links', () => {
      expect(resolveApiShorthand('@api/python/strands.agent.agent')).toBe('/docs/api/python/strands.agent.agent/')
      expect(resolveApiShorthand('@api/python/strands.agent.agent_result')).toBe(
        '/docs/api/python/strands.agent.agent_result/'
      )
      expect(resolveApiShorthand('@api/python/strands.models.bedrock')).toBe('/docs/api/python/strands.models.bedrock/')
    })

    it('should resolve TypeScript API links', () => {
      expect(resolveApiShorthand('@api/typescript/Agent')).toBe('/docs/api/typescript/Agent/')
      expect(resolveApiShorthand('@api/typescript/BedrockModel')).toBe('/docs/api/typescript/BedrockModel/')
    })

    it('should preserve anchors', () => {
      expect(resolveApiShorthand('@api/python/strands.agent.agent#Agent')).toBe('/docs/api/python/strands.agent.agent/#Agent')
      expect(resolveApiShorthand('@api/python/strands.agent.agent_result#AgentResult')).toBe(
        '/docs/api/python/strands.agent.agent_result/#AgentResult'
      )
      expect(resolveApiShorthand('@api/typescript/BedrockModel#constructor')).toBe(
        '/docs/api/typescript/BedrockModel/#constructor'
      )
    })

    it('should handle nested module paths', () => {
      expect(resolveApiShorthand('@api/python/strands.agent.conversation_manager.sliding_window_conversation_manager')).toBe(
        '/docs/api/python/strands.agent.conversation_manager.sliding_window_conversation_manager/'
      )
      expect(
        resolveApiShorthand(
          '@api/python/strands.experimental.bidi.models.google#GoogleGeminiLiveModel'
        )
      ).toBe('/docs/api/python/strands.experimental.bidi.models.google/#GoogleGeminiLiveModel')
    })
  })

  describe('isRelativeLink', () => {
    it('should return false for absolute URLs', () => {
      expect(isRelativeLink('http://example.com')).toBe(false)
      expect(isRelativeLink('https://example.com/path')).toBe(false)
      expect(isRelativeLink('//example.com')).toBe(false)
    })

    it('should return false for absolute paths', () => {
      expect(isRelativeLink('/user-guide/quickstart/')).toBe(false)
      expect(isRelativeLink('/docs/readme')).toBe(false)
    })

    it('should return false for anchor-only links', () => {
      expect(isRelativeLink('#section')).toBe(false)
      expect(isRelativeLink('#')).toBe(false)
    })

    it('should return true for relative links', () => {
      expect(isRelativeLink('sibling.md')).toBe(true)
      expect(isRelativeLink('./sibling.md')).toBe(true)
      expect(isRelativeLink('../parent/file.md')).toBe(true)
      expect(isRelativeLink('subdir/file.md')).toBe(true)
    })
  })

  describe('normalizePath', () => {
    it('should remove empty segments', () => {
      expect(normalizePath(['a', '', 'b'])).toEqual(['a', 'b'])
    })

    it('should remove single dot segments', () => {
      expect(normalizePath(['a', '.', 'b'])).toEqual(['a', 'b'])
    })

    it('should resolve double dot segments', () => {
      expect(normalizePath(['a', 'b', '..', 'c'])).toEqual(['a', 'c'])
      expect(normalizePath(['a', 'b', 'c', '..', '..'])).toEqual(['a'])
    })

    it('should handle multiple consecutive double dots', () => {
      expect(normalizePath(['a', 'b', 'c', '..', '..', 'd'])).toEqual(['a', 'd'])
    })

    it('should not go above root', () => {
      expect(normalizePath(['a', '..', '..'])).toEqual([])
    })
  })

  describe('resolveRelativeLink', () => {
    it('should resolve sibling links', () => {
      expect(
        resolveRelativeLink({ href: 'sibling.md', currentPath: '/user-guide/concepts/agents/state/' })
      ).toBe('user-guide/concepts/agents/sibling')
    })

    it('should resolve sibling links with ./ prefix', () => {
      expect(
        resolveRelativeLink({ href: './sibling.md', currentPath: '/user-guide/concepts/agents/state/' })
      ).toBe('user-guide/concepts/agents/sibling')
    })

    it('should resolve parent directory links', () => {
      expect(
        resolveRelativeLink({ href: '../tools/custom-tools.md', currentPath: '/user-guide/concepts/agents/state/' })
      ).toBe('user-guide/concepts/tools/custom-tools')
    })

    it('should resolve multiple parent directory traversals', () => {
      expect(
        resolveRelativeLink({ href: '../../deploy/docker.md', currentPath: '/user-guide/concepts/agents/state/' })
      ).toBe('user-guide/deploy/docker')
    })

    it('should strip .md extension', () => {
      expect(resolveRelativeLink({ href: 'file.md', currentPath: '/docs/page/' })).toBe('docs/file')
    })

    it('should strip .mdx extension', () => {
      expect(resolveRelativeLink({ href: 'file.mdx', currentPath: '/docs/page/' })).toBe('docs/file')
    })

    it('should preserve anchors', () => {
      expect(resolveRelativeLink({ href: 'file.md#section', currentPath: '/docs/page/' })).toBe('docs/file#section')
      expect(resolveRelativeLink({ href: '../other.md#heading', currentPath: '/docs/subdir/page/' })).toBe(
        'docs/other#heading'
      )
    })

    it('should handle index.md -> parent directory', () => {
      expect(resolveRelativeLink({ href: 'subdir/index.md', currentPath: '/docs/page/' })).toBe('docs/subdir')
      expect(resolveRelativeLink({ href: 'index.md', currentPath: '/docs/page/' })).toBe('docs')
    })

    it('should handle README.md -> parent directory', () => {
      expect(resolveRelativeLink({ href: 'subdir/README.md', currentPath: '/docs/page/' })).toBe('docs/subdir')
      expect(resolveRelativeLink({ href: 'README.md', currentPath: '/docs/page/' })).toBe('docs')
    })

    it('should handle malformed .md/ before anchor', () => {
      expect(resolveRelativeLink({ href: 'file.md/', currentPath: '/docs/page/' })).toBe('docs/file')
    })

    it('should handle paths without leading slash', () => {
      expect(
        resolveRelativeLink({ href: 'sibling.md', currentPath: 'user-guide/concepts/agents/state' })
      ).toBe('user-guide/concepts/agents/sibling')
    })

    it('should resolve sibling links from index pages', () => {
      // When asIndexPage=true, the current path IS the directory
      expect(
        resolveRelativeLink({
          href: 'amazon-bedrock.md',
          currentPath: '/user-guide/concepts/model-providers/',
          asIndexPage: true,
        })
      ).toBe('user-guide/concepts/model-providers/amazon-bedrock')
    })

    it('should resolve parent links from index pages', () => {
      expect(
        resolveRelativeLink({
          href: '../agents/state.md',
          currentPath: '/user-guide/concepts/tools/',
          asIndexPage: true,
        })
      ).toBe('user-guide/concepts/agents/state')
    })
  })

  describe('findDocSlug', () => {
    it('should find exact matches', () => {
      const slugs = new Set(['user-guide/quickstart', 'user-guide/concepts/tools'])
      expect(findDocSlug('user-guide/quickstart', slugs)).toBe('/user-guide/quickstart/')
    })

    it('should return null for non-existent slugs', () => {
      const slugs = new Set(['user-guide/quickstart'])
      expect(findDocSlug('non-existent', slugs)).toBe(null)
    })

    it('should preserve anchors in result', () => {
      const slugs = new Set(['user-guide/quickstart'])
      expect(findDocSlug('user-guide/quickstart#section', slugs)).toBe('/user-guide/quickstart/#section')
    })

    it('should handle trailing slash variations', () => {
      const slugs = new Set(['user-guide/quickstart'])
      expect(findDocSlug('user-guide/quickstart/', slugs)).toBe('/user-guide/quickstart/')
    })
  })

  describe('resolveHref', () => {
    it('should return absolute URLs unchanged', () => {
      const slugs = new Set(['docs/page'])
      const result = resolveHref('https://example.com', '/docs/page/', slugs)
      expect(result.resolvedHref).toBe('https://example.com')
      expect(result.found).toBe(true)
    })

    it('should return anchor-only links unchanged', () => {
      const slugs = new Set(['docs/page'])
      const result = resolveHref('#section', '/docs/page/', slugs)
      expect(result.resolvedHref).toBe('#section')
      expect(result.found).toBe(true)
    })

    it('should resolve relative links when found', () => {
      const slugs = new Set(['docs/sibling'])
      const result = resolveHref('sibling.md', '/docs/page/', slugs)
      expect(result.resolvedHref).toBe('/docs/sibling/')
      expect(result.found).toBe(true)
    })

    it('should return fallback path when not found', () => {
      const slugs = new Set(['docs/other'])
      const result = resolveHref('missing.md', '/docs/page/', slugs)
      expect(result.resolvedHref).toBe('/docs/missing/')
      expect(result.found).toBe(false)
    })

    it('should try index page interpretation when regular fails', () => {
      // Slug exists at user-guide/concepts/model-providers/amazon-bedrock
      // From /user-guide/concepts/model-providers/ (an index page)
      // Link: amazon-bedrock.md
      // Regular interpretation: user-guide/concepts/amazon-bedrock (wrong)
      // Index interpretation: user-guide/concepts/model-providers/amazon-bedrock (correct)
      const slugs = new Set(['user-guide/concepts/model-providers/amazon-bedrock'])
      const result = resolveHref('amazon-bedrock.md', '/user-guide/concepts/model-providers/', slugs)
      expect(result.resolvedHref).toBe('/user-guide/concepts/model-providers/amazon-bedrock/')
      expect(result.found).toBe(true)
    })

    it('should prefer regular page interpretation when both could work', () => {
      // If both interpretations produce valid slugs, prefer regular (more common)
      const slugs = new Set(['docs/sibling', 'docs/page/sibling'])
      const result = resolveHref('sibling.md', '/docs/page/', slugs)
      expect(result.resolvedHref).toBe('/docs/sibling/')
      expect(result.found).toBe(true)
    })

    it('should resolve @api/python shorthand links', () => {
      const slugs = new Set(['docs/api/python/strands.agent.agent', 'docs/api/python/strands.agent.agent_result'])
      const result = resolveHref('@api/python/strands.agent.agent', '/user-guide/quickstart/', slugs)
      expect(result.resolvedHref).toBe('/docs/api/python/strands.agent.agent/')
      expect(result.found).toBe(true)
    })

    it('should resolve @api/typescript shorthand links', () => {
      const slugs = new Set(['docs/api/typescript/Agent', 'docs/api/typescript/BedrockModel'])
      const result = resolveHref('@api/typescript/BedrockModel', '/user-guide/quickstart/', slugs)
      expect(result.resolvedHref).toBe('/docs/api/typescript/BedrockModel/')
      expect(result.found).toBe(true)
    })

    it('should resolve @api shorthand links with anchors', () => {
      const slugs = new Set(['docs/api/python/strands.agent.agent_result'])
      const result = resolveHref('@api/python/strands.agent.agent_result#AgentResult', '/user-guide/quickstart/', slugs)
      expect(result.resolvedHref).toBe('/docs/api/python/strands.agent.agent_result/#AgentResult')
      expect(result.found).toBe(true)
    })

    it('should mark @api shorthand links as not found when slug does not exist', () => {
      const slugs = new Set(['docs/api/python/strands.agent.agent'])
      const result = resolveHref('@api/python/strands.nonexistent.module', '/user-guide/quickstart/', slugs)
      expect(result.resolvedHref).toBe('/docs/api/python/strands.nonexistent.module/')
      expect(result.found).toBe(false)
    })
  })
})

describe('Link Resolution with Content Collection', () => {
  it('should resolve @api shorthand links against real collection', async () => {
    const docs = await getCollection('docs')
    const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

    // Test Python API links
    const pythonTests = [
      { href: '@api/python/strands.agent.agent', expectedSlug: 'api/python/strands.agent.agent' },
      { href: '@api/python/strands.agent.agent_result', expectedSlug: 'api/python/strands.agent.agent_result' },
      { href: '@api/python/strands.models.bedrock', expectedSlug: 'api/python/strands.models.bedrock' },
      {
        href: '@api/python/strands.agent.conversation_manager.sliding_window_conversation_manager',
        expectedSlug: 'api/python/strands.agent.conversation_manager.sliding_window_conversation_manager',
      },
    ]

    for (const { href, expectedSlug } of pythonTests) {
      const result = resolveHref(href, '/user-guide/quickstart/', docSlugs)
      if (docSlugs.has(expectedSlug)) {
        expect(result.found).toBe(true)
        expect(result.resolvedHref).toBe(`/${expectedSlug}/`)
      }
    }

    // Test TypeScript API links
    const tsTests = [
      { href: '@api/typescript/Agent', expectedSlug: 'api/typescript/Agent' },
      { href: '@api/typescript/BedrockModel', expectedSlug: 'api/typescript/BedrockModel' },
    ]

    for (const { href, expectedSlug } of tsTests) {
      const result = resolveHref(href, '/user-guide/quickstart/', docSlugs)
      if (docSlugs.has(expectedSlug)) {
        expect(result.found).toBe(true)
        expect(result.resolvedHref).toBe(`/${expectedSlug}/`)
      }
    }
  })

  it('should resolve @api shorthand links with anchors against real collection', async () => {
    const docs = await getCollection('docs')
    const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

    const result = resolveHref(
      '@api/python/strands.agent.agent_result#AgentResult',
      '/user-guide/quickstart/',
      docSlugs
    )

    if (docSlugs.has('api/python/strands.agent.agent_result')) {
      expect(result.found).toBe(true)
      expect(result.resolvedHref).toBe('/api/python/strands.agent.agent_result/#AgentResult')
    }
  })

  it('should resolve common documentation links', async () => {
    const docs = await getCollection('docs')
    const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

    // Test cases based on actual documentation structure
    const testCases = [
      {
        href: 'conversation-management.md',
        currentPath: '/user-guide/concepts/agents/state/',
        expectedSlug: 'user-guide/concepts/agents/conversation-management',
      },
      {
        href: '../tools/custom-tools.md',
        currentPath: '/user-guide/concepts/agents/state/',
        expectedSlug: 'user-guide/concepts/tools/custom-tools',
      },
      {
        href: 'session-management.md',
        currentPath: '/user-guide/concepts/agents/state/',
        expectedSlug: 'user-guide/concepts/agents/session-management',
      },
    ]

    for (const { href, currentPath, expectedSlug } of testCases) {
      const result = resolveHref(href, currentPath, docSlugs)

      // Check if the expected slug exists in the collection
      if (docSlugs.has(expectedSlug)) {
        expect(result.found).toBe(true)
        expect(result.resolvedHref).toBe(`/${expectedSlug}/`)
      } else {
        console.log(`Note: Expected slug "${expectedSlug}" not found in collection (may not exist yet)`)
      }
    }
  })

  it('should handle links with anchors', async () => {
    const docs = await getCollection('docs')
    const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

    const result = resolveHref('../tools/custom-tools.md#toolcontext', '/user-guide/concepts/agents/state/', docSlugs)

    if (docSlugs.has('user-guide/concepts/tools/custom-tools')) {
      expect(result.found).toBe(true)
      expect(result.resolvedHref).toBe('/user-guide/concepts/tools/custom-tools/#toolcontext')
    }
  })

  it('should log all unresolvable links from a sample page context', async () => {
    const docs = await getCollection('docs')
    const docSlugs = new Set(docs.map((doc) => doc.id)) as Set<string>

    // Sample relative links that might appear in documentation
    const sampleLinks = [
      'conversation-management.md',
      'session-management.md',
      '../tools/index.md',
      '../tools/custom-tools.md',
      '../model-providers/amazon-bedrock.md',
      '../../deploy/operating-agents-in-production.md',
    ]

    const currentPath = '/user-guide/concepts/agents/state/'
    const unresolved: string[] = []

    for (const href of sampleLinks) {
      const result = resolveHref(href, currentPath, docSlugs)
      if (!result.found) {
        unresolved.push(`${href} -> ${result.resolvedHref}`)
      }
    }

    if (unresolved.length > 0) {
      console.log('\n=== Unresolved Links ===')
      for (const link of unresolved) {
        console.log(`  ${link}`)
      }
    }

    // This test documents which links can't be resolved, not a hard failure
    // Useful for identifying missing content during migration
  })
})
