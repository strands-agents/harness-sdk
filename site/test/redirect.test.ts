import { describe, it, expect } from 'vitest'
import { resolveRedirect, resolveRedirectFromUrl } from '../src/util/redirect'

const redirectCases: Array<{ description: string; input: string; expected: string | null }> = [
  // Renamed pages
  {
    description: 'python-tools renamed to custom-tools',
    input: 'docs/user-guide/concepts/tools/python-tools',
    expected: 'docs/user-guide/sdk/tools/custom-tools',
  },
  {
    description: 'concepts/ consolidated under harness/',
    input: 'docs/user-guide/concepts/agents/agent-loop',
    expected: 'docs/user-guide/sdk/agents/agent-loop',
  },
  {
    description: 'concepts/harness overview -> harness landing',
    input: 'docs/user-guide/concepts/harness',
    expected: 'docs/user-guide/sdk',
  },
  {
    description: 'legacy example tutorial -> /examples/ catalog',
    input: 'docs/examples/python/multi_agent_example',
    expected: 'examples',
  },
  // Vanity URLs → external
  { description: '/discord redirects to Discord invite', input: 'discord', expected: 'https://discord.gg/strands' },
  // No redirect
  { description: 'current page returns null', input: 'docs/user-guide/sdk/agents/agent-loop', expected: null },
  { description: 'unknown path returns null', input: 'docs/some/unknown/path', expected: null },
  { description: 'api-reference path returns null', input: 'docs/api-reference/python/agent/agent', expected: null },
  { description: 'api path returns null', input: 'docs/api/python/strands.agent.agent', expected: null },
]

describe('resolveRedirect', () => {
  it.each(redirectCases.map((c) => [c.description, c.input, c.expected]))('%s', (_description, input, expected) => {
    expect(resolveRedirect(input)).toBe(expected)
  })

  it('redirects the retired community-packages page to the integrations page', () => {
    expect(resolveRedirect('docs/community/community-packages')).toBe('integrations')
  })

  it('redirects renamed docs/community pages to docs/integrations', () => {
    expect(resolveRedirect('docs/community/get-featured')).toBe('docs/integrations/get-featured')
    expect(resolveRedirect('docs/community/model-providers/cohere')).toBe('docs/integrations/model-providers/cohere')
  })

  it('redirects the docs/community section root to the integrations page', () => {
    expect(resolveRedirect('docs/community')).toBe('integrations')
  })

  it('redirects unlisted docs/community paths to docs/integrations via the prefix rule', () => {
    expect(resolveRedirect('docs/community/tools/some-future-tool')).toBe('docs/integrations/tools/some-future-tool')
  })

  it('redirects /learn and /community vanity URLs to the start of the learning path', () => {
    expect(resolveRedirect('learn')).toBe('docs/learning/how-agents-really-work')
    expect(resolveRedirect('community')).toBe('docs/learning/how-agents-really-work')
  })

  it('redirects docs/community/learning/lesson1 to docs/learning/how-agents-really-work', () => {
    expect(resolveRedirect('docs/community/learning/lesson1-how-agents-really-work')).toBe(
      'docs/learning/how-agents-really-work'
    )
  })

  it('redirects docs/community/learning/lesson14 to docs/learning/deploying-agents-to-the-cloud', () => {
    expect(resolveRedirect('docs/community/learning/lesson14-deploying-agents-to-the-cloud')).toBe(
      'docs/learning/deploying-agents-to-the-cloud'
    )
  })
})

describe('resolveRedirect with redirectFromMap', () => {
  const redirectFromMap: Record<string, string> = {
    'docs/user-guide/concepts/model-providers/cohere': 'docs/integrations/model-providers/cohere',
    'docs/user-guide/concepts/model-providers/fireworksai': 'docs/integrations/model-providers/fireworksai',
    'docs/old/path': 'docs/new/path',
  }

  it('should resolve redirectFrom mappings correctly', () => {
    expect(resolveRedirect('docs/user-guide/concepts/model-providers/cohere', redirectFromMap)).toBe(
      'docs/integrations/model-providers/cohere'
    )
    expect(resolveRedirect('docs/user-guide/concepts/model-providers/fireworksai', redirectFromMap)).toBe(
      'docs/integrations/model-providers/fireworksai'
    )
    expect(resolveRedirect('docs/old/path', redirectFromMap)).toBe('docs/new/path')
  })

  it('should give SLUG_RULES priority over redirectFrom mappings', () => {
    // python-tools is in SLUG_RULES, so it should redirect to custom-tools even if in redirectFromMap
    const mapWithConflict: Record<string, string> = {
      'docs/user-guide/concepts/tools/python-tools': 'docs/some/other/place',
    }
    expect(resolveRedirect('docs/user-guide/concepts/tools/python-tools', mapWithConflict)).toBe(
      'docs/user-guide/sdk/tools/custom-tools'
    )
  })

  it('should return null for unknown slugs not in either SLUG_RULES or redirectFromMap', () => {
    expect(resolveRedirect('docs/completely/unknown/path', redirectFromMap)).toBe(null)
  })

  it('should work without redirectFromMap (backward compatible)', () => {
    expect(resolveRedirect('docs/user-guide/concepts/tools/python-tools')).toBe(
      'docs/user-guide/sdk/tools/custom-tools'
    )
    expect(resolveRedirect('docs/some/unknown/path')).toBe(null)
  })
})

const urlCases: Array<{ description: string; path: string; expected: string | null }> = [
  { description: 'latest root redirects to /', path: '/latest/', expected: '/' },
  { description: '1.x root redirects to /', path: '/1.x/', expected: '/' },
  { description: '1.5.x root redirects to /', path: '/1.5.x/', expected: '/' },
  { description: '1.x docs index redirects to docs/', path: '/1.x/documentation/docs/', expected: 'docs/' },
  { description: 'latest docs index redirects to docs/', path: '/latest/documentation/docs/', expected: 'docs/' },
  {
    description: '1.5.x doc page with trailing slash passes through',
    path: '/1.5.x/documentation/docs/user-guide/sdk/agents/state/',
    expected: 'docs/user-guide/sdk/agents/state/',
  },
  {
    description: '1.5.x doc page without trailing slash',
    path: '/1.5.x/documentation/docs/user-guide/sdk/agents/state',
    expected: 'docs/user-guide/sdk/agents/state',
  },
  {
    description: 'unrecognised path with trailing slash passes through',
    path: '/latest/some/other/path/',
    expected: 'some/other/path/',
  },
  {
    description: 'unrecognised path without trailing slash',
    path: '/latest/some/other/path',
    expected: 'some/other/path',
  },
  {
    description: 'retired community-packages page with trailing slash redirects to integrations',
    path: '/1.x/documentation/docs/community/community-packages/',
    expected: 'integrations/',
  },
  {
    description: 'retired community-packages page without trailing slash redirects to integrations',
    path: '/1.x/documentation/docs/community/community-packages',
    expected: 'integrations',
  },
  {
    description: 'renamed community docs page redirects to integrations section',
    path: '/latest/documentation/docs/community/model-providers/cohere/',
    expected: 'docs/integrations/model-providers/cohere/',
  },
  {
    description: 'unlisted community docs page redirects via prefix rule',
    path: '/latest/documentation/docs/community/tools/some-future-tool/',
    expected: 'docs/integrations/tools/some-future-tool/',
  },
  {
    description: 'renamed page with trailing slash',
    path: '/latest/documentation/docs/user-guide/concepts/tools/python-tools/',
    expected: 'docs/user-guide/sdk/tools/custom-tools/',
  },
  {
    description: 'renamed page without trailing slash',
    path: '/latest/documentation/docs/user-guide/concepts/tools/python-tools',
    expected: 'docs/user-guide/sdk/tools/custom-tools',
  },
  // we don't rewrite these because they're subject to change quite a bit
  {
    description: 'api-reference path passes through unrewritten',
    path: '/latest/documentation/docs/api-reference/python/agent/agent/',
    expected: 'docs/api-reference/python/agent/agent/',
  },
  // paths with file extensions must not have a trailing slash added
  {
    description: 'index.md path has no trailing slash added',
    path: '/latest/documentation/docs/some/files/index.md',
    expected: 'docs/some/files/index.md',
  },
  {
    description: '.txt path has no trailing slash added',
    path: '/latest/documentation/docs/llms.txt',
    expected: 'docs/llms.txt',
  },
  // Top-level versioned paths (not under /documentation/docs/) pass through after version strip
  { description: 'versioned llms.txt redirects to llms.txt', path: '/latest/llms.txt', expected: 'llms.txt' },
  // Open redirect prevention: absolute URLs from path normalization are rejected.
  // Only explicit SLUG_RULES may return external URLs.
  { description: 'rejects https:// open redirect via /latest/', path: '/latest/https://evil.com/', expected: null },
  { description: 'rejects http:// open redirect via /latest/', path: '/latest/http://evil.com/', expected: null },
  { description: 'rejects https:// open redirect via version prefix', path: '/1.x/https://evil.com/', expected: null },
  {
    description: 'rejects https:// open redirect without trailing /',
    path: '/latest/https://evil.com',
    expected: null,
  },
]

describe('resolveRedirectFromUrl', () => {
  it.each(urlCases.map((c) => [c.description, c.path, c.expected]))('%s', (_description, path, expected) => {
    expect(resolveRedirectFromUrl(path)).toBe(expected)
  })
})
