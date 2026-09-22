import type { StarlightRouteData } from '@astrojs/starlight/route-data'
import { getCollection } from 'astro:content'
import { CATALOG_TYPES } from '../components/catalog/types'
import { toCardModel, sortEntries, type CatalogStatsFile } from './catalog'
import statsFile from '../data/catalog-stats.json'
import { pathWithBase } from './links'

type SidebarEntry = StarlightRouteData['sidebar'][number]

const GET_FEATURED_SLUG = 'docs/integrations/get-featured'

/**
 * The /integrations catalog sidebar in Starlight route-data form: a "Browse by
 * type" group plus the "Add your integration" link. The catalog page renders it
 * via its own frontmatter; the get-featured page reuses it here so it sits
 * inside the same rail (see route-middleware.ts) rather than rendering bare.
 */
export async function buildIntegrationsSidebar(currentSlug: string): Promise<SidebarEntry[]> {
  const stats = statsFile as CatalogStatsFile
  const entries = await getCollection('catalog')
  const buildDate = new Date()
  const cards = sortEntries(entries.map((e) => toCardModel(e.id, e.data, stats[e.id], buildDate)))

  const typeFacets = CATALOG_TYPES.map(({ value, labelPlural }) => ({
    value,
    label: labelPlural,
    count: cards.filter((c) => c.integrationType === value).length,
  })).filter((t) => t.count > 0)

  const link = (label: string, href: string, isCurrent = false): SidebarEntry => ({
    type: 'link',
    label,
    href: pathWithBase(href),
    isCurrent,
    badge: undefined,
    attrs: {},
  })

  return [
    {
      type: 'group',
      label: 'Integrations',
      collapsed: false,
      badge: undefined,
      entries: [
        link('All integrations', '/integrations/'),
        ...typeFacets.map((t) => link(t.label, `/integrations/?type=${t.value}`)),
      ],
    },
    link('Add your integration', '/docs/integrations/get-featured/', currentSlug === GET_FEATURED_SLUG),
  ]
}
