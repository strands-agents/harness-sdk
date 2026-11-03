/**
 * Shared JSON-LD structured data schemas for SEO.
 * Used by Head.astro (docs, blog, and changelog pages).
 */

/**
 * Serialize JSON-LD for insertion into a script element with `set:html`.
 *
 * JSON.stringify does not escape `<`, so a string containing `</script>` can
 * terminate the element before the browser parses the JSON. Escaping `<` as a
 * JSON Unicode sequence preserves the parsed value without creating HTML.
 */
export function serializeJsonLd(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const breadcrumbLabels: Record<string, string> = {
  docs: 'Docs',
  'user-guide': 'User Guide',
  concepts: 'Concepts',
  agents: 'Agents',
  tools: 'Tools',
  'multi-agent': 'Multi-Agent',
  'model-providers': 'Model Providers',
  streaming: 'Streaming',
  bidi: 'Voice',
  deploy: 'Deploy',
  'safety-security': 'Safety & Security',
  'observability-evaluation': 'Observability',
  'evals-sdk': 'Evals SDK',
  examples: 'Examples',
  community: 'Community',
  labs: 'Labs',
  contribute: 'Contribute',
  api: 'API Reference',
  plugins: 'Plugins',
  quickstart: 'Quickstart',
  experimental: 'Experimental',
  python: 'Python',
  typescript: 'TypeScript',
  integrations: 'Integrations',
  'session-managers': 'Session Managers',
  contributing: 'Contributing',
}

export interface BreadcrumbItem {
  '@type': 'ListItem'
  position: number
  name: string
  item?: string
}

function segmentLabel(segment: string): string {
  return (
    breadcrumbLabels[segment] ?? segment.replace(/-/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  )
}

function breadcrumbItem(
  segments: string[],
  position: number,
  name: string,
  siteUrl: string,
  basePath: string,
  link: boolean
): BreadcrumbItem {
  const path = `/${segments.join('/')}/`
  return {
    '@type': 'ListItem',
    position,
    name,
    ...(link ? { item: `${siteUrl}${basePath}${path}` } : {}),
  }
}

/**
 * Build breadcrumb JSON-LD from the canonical route id.
 *
 * Sample guide language and category segments are navigation groupings without
 * landing routes, so sample breadcrumbs link only the real `/examples/` parent.
 */
export function buildBreadcrumbItems(routeId: string, title: string, siteUrl: string, basePath = ''): BreadcrumbItem[] {
  const segments = routeId
    .replace(/^\/|\/$/g, '')
    .split('/')
    .filter(Boolean)
  if (segments.length === 0) return []

  if (segments[0] === 'examples' && segments.length > 1) {
    return [
      breadcrumbItem(['examples'], 1, 'Examples', siteUrl, basePath, true),
      breadcrumbItem(segments, 2, title, siteUrl, basePath, false),
    ]
  }

  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1
    return breadcrumbItem(
      segments.slice(0, index + 1),
      index + 1,
      isLast ? title : segmentLabel(segment),
      siteUrl,
      basePath,
      !isLast
    )
  })
}

export function baseSchemas(siteUrl: string) {
  return [
    {
      '@type': 'Organization',
      name: 'Strands Agents',
      url: siteUrl,
      logo: siteUrl + '/favicon.svg',
      sameAs: ['https://github.com/strands-agents'],
      parentOrganization: {
        '@type': 'Organization',
        name: 'Amazon Web Services',
        url: 'https://aws.amazon.com',
      },
    },
    // No potentialAction/SearchAction: site search is Pagefind, a client-side
    // modal with no query-parameter URL — a SearchAction target would be fake.
    {
      '@type': 'WebSite',
      name: 'Strands Agents',
      url: siteUrl,
      publisher: { '@type': 'Organization', name: 'Strands Agents', url: siteUrl },
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Strands Agents SDK',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Cross-platform',
      programmingLanguage: ['Python', 'TypeScript'],
      license: 'https://github.com/strands-agents/harness-sdk/blob/main/LICENSE.APACHE',
      url: siteUrl,
      author: { '@type': 'Organization', name: 'Strands Agents' },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ]
}
