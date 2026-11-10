import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { buildApiCounterpartMap, type ApiDocEntry } from '../src/util/api-counterparts'
import { getLanguageSwitchTarget } from '../src/util/language-switch'

describe('buildApiCounterpartMap', () => {
  const entries: ApiDocEntry[] = [
    {
      id: 'docs/api/python/strands.models.bedrock',
      body: '<a id="strands.models.bedrock.BedrockModel"></a>\n<a id="strands.models.bedrock.BedrockModel.stream"></a>',
    },
    {
      id: 'docs/api/python/strands.agent.conversation_manager.conversation_manager',
      body: [
        '<a id="strands.agent.conversation_manager.conversation_manager.ProactiveCompressionConfig"></a>',
        '<a id="strands.agent.conversation_manager.conversation_manager.ConversationManager"></a>',
      ].join('\n'),
    },
    {
      id: 'docs/api/python/strands.agent.a2a_agent',
      body: '<a id="strands.agent.a2a_agent.A2AAgent"></a>',
    },
    { id: 'docs/api/typescript/BedrockModel', body: '' },
    { id: 'docs/api/typescript/ProactiveCompressionConfig', body: '' },
    { id: 'docs/api/typescript/ConversationManager', body: '' },
    { id: 'docs/api/typescript', body: '' },
    { id: 'docs/api/python', body: '' },
  ]
  const map = buildApiCounterpartMap(entries)

  it('pairs a Python module page with the TypeScript page of its symbol', () => {
    expect(map.get('docs/api/python/strands.models.bedrock')).toBe('/docs/api/typescript/BedrockModel/')
  })

  it('pairs a TypeScript symbol page back to the Python module page with an anchor', () => {
    expect(map.get('docs/api/typescript/BedrockModel')).toBe(
      '/docs/api/python/strands.models.bedrock/#strands.models.bedrock.BedrockModel'
    )
  })

  it('prefers the symbol named after the module when several symbols match', () => {
    expect(map.get('docs/api/python/strands.agent.conversation_manager.conversation_manager')).toBe(
      '/docs/api/typescript/ConversationManager/'
    )
  })

  it('matches the module-named symbol despite acronym casing', () => {
    const acronymEntries: ApiDocEntry[] = [
      {
        id: 'docs/api/python/strands.agent.a2a_agent',
        body: '<a id="strands.agent.a2a_agent.AgentCard"></a>\n<a id="strands.agent.a2a_agent.A2AAgent"></a>',
      },
      { id: 'docs/api/typescript/AgentCard', body: '' },
      { id: 'docs/api/typescript/A2AAgent', body: '' },
    ]
    const acronymMap = buildApiCounterpartMap(acronymEntries)
    // pascalCase('a2a_agent') would be 'A2aAgent'; the case-insensitive match
    // must still pick A2AAgent over the first documented symbol (AgentCard).
    expect(acronymMap.get('docs/api/python/strands.agent.a2a_agent')).toBe('/docs/api/typescript/A2AAgent/')
  })

  it('leaves pages without a shared symbol out of the map', () => {
    // A2AAgent has no TypeScript page in this fixture
    expect(map.has('docs/api/python/strands.agent.a2a_agent')).toBe(false)
  })

  it('treats regex metacharacters in module ids literally', () => {
    // A module id containing regex metacharacters must not let "x" match the
    // "x+y" wildcard position, and must still match its own anchors exactly.
    const metaEntries: ApiDocEntry[] = [
      {
        id: 'docs/api/python/strands.x+y',
        body: '<a id="strands.x+y.Widget"></a>\n<a id="strands.xxy.Impostor"></a>',
      },
      { id: 'docs/api/typescript/Widget', body: '' },
      { id: 'docs/api/typescript/Impostor', body: '' },
    ]
    const metaMap = buildApiCounterpartMap(metaEntries)
    expect(metaMap.get('docs/api/python/strands.x+y')).toBe('/docs/api/typescript/Widget/')
  })

  it('does not pair the section index pages', () => {
    expect(map.has('docs/api/typescript')).toBe(false)
    expect(map.has('docs/api/python')).toBe(false)
  })

  it('prefers the stable module over an experimental one for shared symbols', () => {
    // Role is documented by both a stable and an experimental module; the TS
    // page must link to the stable one regardless of entry order.
    const sharedEntries: ApiDocEntry[] = [
      {
        id: 'docs/api/python/strands.experimental.bidi.types',
        body: '<a id="strands.experimental.bidi.types.Role"></a>',
      },
      {
        id: 'docs/api/python/strands.types.content.role_definitions',
        body: '<a id="strands.types.content.role_definitions.Role"></a>',
      },
      { id: 'docs/api/typescript/Role', body: '' },
    ]
    const sharedMap = buildApiCounterpartMap(sharedEntries)
    expect(sharedMap.get('docs/api/typescript/Role')).toBe(
      '/docs/api/python/strands.types.content.role_definitions/#strands.types.content.role_definitions.Role'
    )
  })
})

describe('getLanguageSwitchTarget with API counterparts', () => {
  const docIds = new Set([
    'docs/api/python',
    'docs/api/typescript',
    'docs/api/python/strands.models.bedrock',
    'docs/api/typescript/BedrockModel',
  ])
  const counterparts = new Map([
    ['docs/api/python/strands.models.bedrock', '/docs/api/typescript/BedrockModel/'],
    [
      'docs/api/typescript/BedrockModel',
      '/docs/api/python/strands.models.bedrock/#strands.models.bedrock.BedrockModel',
    ],
  ])

  it('deep-links to the symbol counterpart when one is known', () => {
    expect(
      getLanguageSwitchTarget('/docs/api/python/strands.models.bedrock/', 'typescript', docIds, counterparts)
    ).toBe('/docs/api/typescript/BedrockModel/')
    expect(getLanguageSwitchTarget('/docs/api/typescript/BedrockModel/', 'python', docIds, counterparts)).toBe(
      '/docs/api/python/strands.models.bedrock/#strands.models.bedrock.BedrockModel'
    )
  })

  it('falls back to the section index for unmapped pages', () => {
    expect(getLanguageSwitchTarget('/docs/api/python/strands.unmapped.page/', 'typescript', docIds, counterparts)).toBe(
      '/docs/api/typescript/'
    )
  })
})

describe('against the real content collection', () => {
  it('every counterpart target resolves to an existing page', async () => {
    const docs = await getCollection('docs')
    const ids = new Set(docs.map((doc) => doc.id))
    const map = buildApiCounterpartMap(docs.map((doc) => ({ id: doc.id, body: doc.body })))

    const broken: string[] = []
    for (const [source, target] of map) {
      const targetSlug = target.replace(/^\//, '').replace(/\/(#.*)?$/, '')
      if (!ids.has(targetSlug)) broken.push(`${source} -> ${target}`)
    }

    expect(broken, `Counterpart targets that do not exist:\n${broken.join('\n')}`).toEqual([])
  })

  it('pairs a meaningful share of the API reference in both directions', async () => {
    const docs = await getCollection('docs')
    const map = buildApiCounterpartMap(docs.map((doc) => ({ id: doc.id, body: doc.body })))

    const pyMapped = [...map.keys()].filter((id) => id.startsWith('docs/api/python/')).length
    const tsMapped = [...map.keys()].filter((id) => id.startsWith('docs/api/typescript/')).length
    // Guards against the anchor format or page naming silently changing and
    // emptying the map (which would demote every API switch to the index).
    expect(pyMapped).toBeGreaterThan(20)
    expect(tsMapped).toBeGreaterThan(50)
  })

  it('maps the Agent pages to each other', async () => {
    const docs = await getCollection('docs')
    const map = buildApiCounterpartMap(docs.map((doc) => ({ id: doc.id, body: doc.body })))

    expect(map.get('docs/api/python/strands.agent.agent')).toBe('/docs/api/typescript/Agent/')
    expect(map.get('docs/api/typescript/Agent')).toBe('/docs/api/python/strands.agent.agent/#strands.agent.agent.Agent')
  })
})
