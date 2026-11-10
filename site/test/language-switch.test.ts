import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { getLanguageSwitchTarget } from '../src/util/language-switch'
import { buildApiCounterpartMap } from '../src/util/api-counterparts'

describe('getLanguageSwitchTarget', () => {
  const docIds = new Set([
    'docs/user-guide/quickstart/python',
    'docs/user-guide/quickstart/typescript',
    'docs/user-guide/deploy/deploy_to_docker/python',
    'docs/user-guide/deploy/deploy_to_docker/typescript',
    'docs/api/python',
    'docs/api/typescript',
    'docs/api/python/strands.agent.a2a_agent',
    'docs/api/python/strands.models.bedrock',
    'docs/api/typescript/Agent',
    'docs/api/typescript/BedrockModel',
    'docs/user-guide/concepts/agents/state',
  ])

  it('swaps to the exact counterpart when it exists', () => {
    expect(getLanguageSwitchTarget('/docs/user-guide/quickstart/python/', 'typescript', docIds)).toBe(
      '/docs/user-guide/quickstart/typescript/'
    )
    expect(getLanguageSwitchTarget('/docs/user-guide/deploy/deploy_to_docker/typescript/', 'python', docIds)).toBe(
      '/docs/user-guide/deploy/deploy_to_docker/python/'
    )
  })

  it('falls back to the section index when no counterpart page exists', () => {
    // Python API module pages have no TypeScript equivalent (different structure)
    expect(getLanguageSwitchTarget('/docs/api/python/strands.agent.a2a_agent/', 'typescript', docIds)).toBe(
      '/docs/api/typescript/'
    )
    expect(getLanguageSwitchTarget('/docs/api/typescript/Agent/', 'python', docIds)).toBe('/docs/api/python/')
  })

  it('swaps between API index pages directly', () => {
    expect(getLanguageSwitchTarget('/docs/api/python/', 'typescript', docIds)).toBe('/docs/api/typescript/')
  })

  it('returns null when the page has no language segment', () => {
    expect(getLanguageSwitchTarget('/docs/user-guide/concepts/agents/state/', 'typescript', docIds)).toBeNull()
    expect(getLanguageSwitchTarget('/', 'python', docIds)).toBeNull()
  })

  it('returns null when the page is already in the target language', () => {
    expect(getLanguageSwitchTarget('/docs/api/python/strands.models.bedrock/', 'python', docIds)).toBeNull()
    expect(getLanguageSwitchTarget('/docs/user-guide/quickstart/typescript/', 'typescript', docIds)).toBeNull()
  })

  it('returns null when neither counterpart nor section index exists', () => {
    const sparse = new Set(['docs/api/python/strands.models.bedrock'])
    expect(getLanguageSwitchTarget('/docs/api/python/strands.models.bedrock/', 'typescript', sparse)).toBeNull()
  })

  it('handles paths without a trailing slash', () => {
    expect(getLanguageSwitchTarget('/docs/user-guide/quickstart/python', 'typescript', docIds)).toBe(
      '/docs/user-guide/quickstart/typescript/'
    )
  })

  describe('against the real content collection', () => {
    it('every language-paired page resolves to an existing page in the other language', async () => {
      const docs = await getCollection('docs')
      const ids = new Set(docs.map((doc) => doc.id))
      const counterparts = buildApiCounterpartMap(docs.map((doc) => ({ id: doc.id, body: doc.body })))

      const broken: string[] = []
      for (const doc of docs) {
        for (const target of ['python', 'typescript'] as const) {
          const result = getLanguageSwitchTarget(`/${doc.id}/`, target, ids, counterparts)
          const resultSlug = result?.replace(/^\//, '').replace(/\/(#.*)?$/, '')
          if (resultSlug && !ids.has(resultSlug)) {
            broken.push(`${doc.id} -> ${result}`)
          }
        }
      }

      expect(broken, `Language switch resolved to non-existent pages:\n${broken.join('\n')}`).toEqual([])
    })

    it('API reference pages never resolve to a naive slug swap that does not exist', async () => {
      const docs = await getCollection('docs')
      const ids = new Set(docs.map((doc) => doc.id))

      // The bug this guards against: /docs/api/python/strands.agent.a2a_agent/
      // naively swapped to /docs/api/typescript/strands.agent.a2a_agent/ (404).
      // Without a counterpart map the switch lands on the section index.
      const target = getLanguageSwitchTarget('/docs/api/python/strands.agent.a2a_agent/', 'typescript', ids)
      expect(target).toBe('/docs/api/typescript/')
    })
  })
})
