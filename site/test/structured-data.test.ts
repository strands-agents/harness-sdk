import path from 'node:path'

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { loadProductsFromConfig } from '../src/sidebar'
import { buildBreadcrumbItems, PRODUCT_SOURCE, serializeJsonLd } from '../src/util/structured-data'

describe('buildBreadcrumbItems', () => {
  const pageIds = new Set(['docs/user-guide/sdk', 'docs/user-guide/sdk/agents'])

  it('links only ancestors that have a page and labels the current page', () => {
    expect(
      buildBreadcrumbItems('docs/user-guide/sdk/agents/agent-loop', 'Agent loop', 'https://strandsagents.com', pageIds)
    ).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Harness SDK',
        item: 'https://strandsagents.com/docs/user-guide/sdk/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Agents',
        item: 'https://strandsagents.com/docs/user-guide/sdk/agents/',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'Agent loop',
      },
    ])
  })

  it('links section landing pages outside the docs collection', () => {
    expect(
      buildBreadcrumbItems('changelog/sdk/python-v1.9.0', 'SDK Python v1.9.0', 'https://strandsagents.com', pageIds)
    ).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Changelog',
        item: 'https://strandsagents.com/changelog/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'SDK Python v1.9.0',
      },
    ])
  })

  it('omits sample language and category groupings without landing routes', () => {
    expect(
      buildBreadcrumbItems(
        'examples/typescript/use-cases/first-agent',
        'First agent',
        'https://strandsagents.com',
        pageIds,
        '/preview'
      )
    ).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Examples',
        item: 'https://strandsagents.com/preview/examples/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'First agent',
      },
    ])
  })
})

describe('product structured data', () => {
  it('every product has a source repository', () => {
    const products = loadProductsFromConfig(path.resolve('./src/config/navigation.yml'))
    expect(Object.keys(PRODUCT_SOURCE).sort()).toEqual(products.map((p) => p.label).sort())
  })
})

describe('JSON-LD serialization', () => {
  it('cannot terminate the containing script element', () => {
    const title = '</script><script id="injected"></script>'
    const serialized = serializeJsonLd({ title })
    const document = new JSDOM(`<script type="application/ld+json">${serialized}</script>`).window.document

    expect(serialized).not.toContain('</script>')
    expect(document.scripts).toHaveLength(1)
    expect(document.querySelector('#injected')).toBeNull()
    expect(JSON.parse(document.scripts[0]?.textContent ?? '{}')).toEqual({ title })
  })
})
