import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { pathWithBase } from '../src/util/links'
import {
  articleSchema,
  buildBreadcrumbItems,
  faqPageSchema,
  integrationsSchema,
  productSchema,
  releaseSchema,
  serializeJsonLd,
} from '../src/util/structured-data'
import type { ChangelogFrontmatter } from '../src/content.config'
import type { Product } from '../src/sidebar'
import type { CatalogCardModel } from '../src/util/catalog'

const site = 'https://strandsagents.com'
const organization = { '@id': `${site}/#organization` }

const shell: Product = {
  label: 'Shell',
  name: 'Strands Shell',
  slug: '/shell',
  href: '/docs/user-guide/shell/',
  description: 'A virtual shell designed for AI agents to use safely.',
  repository: 'https://github.com/strands-agents/shell',
  languages: ['Rust'],
}

describe('buildBreadcrumbItems', () => {
  const pageTitles = new Map([
    ['docs/user-guide/sdk', 'Harness SDK'],
    ['docs/user-guide/sdk/agents', 'Anatomy of an agent'],
  ])

  it('names linked ancestors after their page titles', () => {
    expect(buildBreadcrumbItems('docs/user-guide/sdk/agents/agent-loop', 'Agent loop', site, pageTitles)).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Harness SDK',
        item: 'https://strandsagents.com/docs/user-guide/sdk/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Anatomy of an agent',
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
    expect(buildBreadcrumbItems('changelog/sdk/python-v1.9.0', 'SDK Python v1.9.0', site, pageTitles)).toEqual([
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
      buildBreadcrumbItems('examples/typescript/use-cases/first-agent', 'First agent', site, pageTitles, '/preview')
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

describe('productSchema', () => {
  it('describes the product and its source repository', () => {
    expect(productSchema(shell, site)).toEqual({
      '@type': 'SoftwareApplication',
      '@id': `${site}/docs/user-guide/shell/#software`,
      name: 'Strands Shell',
      description: 'A virtual shell designed for AI agents to use safely.',
      url: `${site}/docs/user-guide/shell/`,
      applicationCategory: 'DeveloperApplication',
      license: 'https://www.apache.org/licenses/LICENSE-2.0',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: organization,
      isBasedOn: {
        '@type': 'SoftwareSourceCode',
        codeRepository: 'https://github.com/strands-agents/shell',
        programmingLanguage: ['Rust'],
      },
    })
  })
})

describe('articleSchema', () => {
  const url = `${site}/docs/user-guide/shell/quickstart/`

  it('includes every optional property that has a value', () => {
    expect(
      articleSchema(
        {
          type: 'TechArticle',
          title: 'Quickstart',
          description: 'Run your first command.',
          url,
          dateModified: new Date('2026-11-01T00:00:00.000Z'),
          keywords: ['shell', 'sandbox'],
          relatedLinks: [`${site}/docs/user-guide/shell/security/`],
          sources: [
            {
              programmingLanguage: 'Rust',
              codeRepository: 'https://github.com/strands-agents/shell',
              url: 'https://github.com/strands-agents/shell/blob/main/src/lib.rs',
            },
          ],
          product: shell,
        },
        site
      )
    ).toEqual({
      '@type': 'TechArticle',
      headline: 'Quickstart',
      description: 'Run your first command.',
      url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url, relatedLink: [`${site}/docs/user-guide/shell/security/`] },
      dateModified: '2026-11-01T00:00:00.000Z',
      author: organization,
      publisher: organization,
      about: { '@id': `${site}/docs/user-guide/shell/#software` },
      keywords: 'shell, sandbox',
      isBasedOn: [
        {
          '@type': 'SoftwareSourceCode',
          programmingLanguage: 'Rust',
          codeRepository: 'https://github.com/strands-agents/shell',
          url: 'https://github.com/strands-agents/shell/blob/main/src/lib.rs',
        },
      ],
    })
  })

  it('omits optional properties without a value', () => {
    expect(articleSchema({ type: 'APIReference', title: 'Agent', url }, site)).toEqual({
      '@type': 'APIReference',
      headline: 'Agent',
      url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      author: organization,
      publisher: organization,
    })
  })
})

describe('releaseSchema', () => {
  const release = (sdk: ChangelogFrontmatter['sdk'], language?: 'python'): ChangelogFrontmatter => ({
    sdk,
    ...(language && { language }),
    version: '1.2.0',
    tag: 'v1.2.0',
    date: new Date('2026-10-30T00:00:00.000Z'),
    releaseUrl: 'https://github.com/strands-agents/harness-sdk/releases/tag/v1.2.0',
    packageUrl: 'https://pypi.org/project/strands-agents/1.2.0/',
    entries: [],
    newContributors: [],
  })
  const pageUrl = `${site}/changelog/sdk/python-v1.2.0/`

  it('names the release after its product and links to it', () => {
    const sdk: Product = {
      ...shell,
      label: 'Harness SDK',
      name: 'Strands Harness SDK',
      href: '/docs/user-guide/sdk/',
      repository: 'https://github.com/strands-agents/harness-sdk',
      languages: ['Python', 'TypeScript'],
    }
    expect(releaseSchema(release('sdk', 'python'), pageUrl, site, sdk)).toEqual({
      '@type': 'SoftwareApplication',
      '@id': `${pageUrl}#release`,
      name: 'Strands Harness SDK Python',
      softwareVersion: '1.2.0',
      datePublished: '2026-10-30T00:00:00.000Z',
      releaseNotes: pageUrl,
      downloadUrl: 'https://pypi.org/project/strands-agents/1.2.0/',
      applicationCategory: 'DeveloperApplication',
      publisher: organization,
      isPartOf: { '@id': `${site}/docs/user-guide/sdk/#software` },
    })
  })

  it('falls back to the stream label for releases without a product', () => {
    expect(releaseSchema(release('cli'), pageUrl, site, undefined)).toEqual({
      '@type': 'SoftwareApplication',
      '@id': `${pageUrl}#release`,
      name: 'Strands Harness CLI',
      softwareVersion: '1.2.0',
      datePublished: '2026-10-30T00:00:00.000Z',
      releaseNotes: pageUrl,
      downloadUrl: 'https://pypi.org/project/strands-agents/1.2.0/',
      applicationCategory: 'DeveloperApplication',
      publisher: organization,
    })
  })
})

describe('integrationsSchema', () => {
  const card = (overrides: Partial<CatalogCardModel>): CatalogCardModel => ({
    id: 'example',
    name: 'Example',
    description: 'An example integration.',
    integrationType: 'tool',
    maintainedBy: 'community',
    sdk: 'agents',
    languages: ['python'],
    href: '/docs/integrations/example/',
    external: false,
    github: 'https://github.com/example/example',
    registryLinks: [],
    maintainer: 'example',
    featured: false,
    badges: [],
    ...overrides,
  })

  it('lists each integration as source code, resolving internal links against the site', () => {
    const pageUrl = `${site}/integrations/`
    expect(
      integrationsSchema(
        [
          card({}),
          card({
            name: 'Vendor',
            href: 'https://vendor.example/strands',
            external: true,
            languages: ['python', 'typescript'],
            github: 'https://github.com/vendor/strands',
          }),
        ],
        pageUrl,
        site
      )
    ).toEqual({
      '@type': 'ItemList',
      '@id': `${pageUrl}#integrations`,
      name: 'Strands Agents integrations',
      numberOfItems: 2,
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          item: {
            '@type': 'SoftwareSourceCode',
            name: 'Example',
            description: 'An example integration.',
            url: site + pathWithBase('/docs/integrations/example/'),
            codeRepository: 'https://github.com/example/example',
            programmingLanguage: ['Python'],
          },
        },
        {
          '@type': 'ListItem',
          position: 2,
          item: {
            '@type': 'SoftwareSourceCode',
            name: 'Vendor',
            description: 'An example integration.',
            url: 'https://vendor.example/strands',
            codeRepository: 'https://github.com/vendor/strands',
            programmingLanguage: ['Python', 'TypeScript'],
          },
        },
      ],
    })
  })
})

describe('faqPageSchema', () => {
  it('publishes questions with their accepted answers', () => {
    const pageUrl = `${site}/faq/`

    expect(
      faqPageSchema(
        [
          {
            question: 'Can I keep my current model?',
            answer: 'Yes, when the provider supports the capabilities your agent needs.',
          },
        ],
        pageUrl
      )
    ).toEqual({
      '@type': 'FAQPage',
      '@id': `${pageUrl}#faq`,
      url: pageUrl,
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Can I keep my current model?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes, when the provider supports the capabilities your agent needs.',
          },
        },
      ],
    })
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
