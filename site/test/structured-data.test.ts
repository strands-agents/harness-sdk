import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { buildBreadcrumbItems, serializeJsonLd } from '../src/util/structured-data'

describe('buildBreadcrumbItems', () => {
  it('links regular route ancestors and labels the current page', () => {
    expect(
      buildBreadcrumbItems('docs/user-guide/sdk/quickstart', 'SDK quickstart', 'https://strandsagents.com')
    ).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Docs',
        item: 'https://strandsagents.com/docs/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'User Guide',
        item: 'https://strandsagents.com/docs/user-guide/',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'Sdk',
        item: 'https://strandsagents.com/docs/user-guide/sdk/',
      },
      {
        '@type': 'ListItem',
        position: 4,
        name: 'SDK quickstart',
      },
    ])
  })

  it('omits sample language and category groupings without landing routes', () => {
    expect(
      buildBreadcrumbItems(
        'examples/typescript/use-cases/first-agent',
        'First agent',
        'https://strandsagents.com',
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
