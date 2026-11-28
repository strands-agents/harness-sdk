import type { StarlightRouteData } from '@astrojs/starlight/route-data'
import { CATALOG_TYPES } from '../components/catalog/types'
import type { CatalogCardModel } from './catalog'
import { loadCatalogCards } from './catalog-cards'
import { pathWithBase } from './links'
import { CATALOG_PATH, catalogTypePath } from './catalog-routes'

type SidebarEntry = StarlightRouteData['sidebar'][number]

const GET_FEATURED_PATH = '/docs/integrations/get-featured/'

/** The catalog rail's links: every type, then each type that has entries, then "Add your integration". */
function catalogLinks(cards: CatalogCardModel[]) {
  const types = CATALOG_TYPES.filter(({ value }) => cards.some((c) => c.integrationType === value))
  return {
    browse: [
      { label: 'All integrations', link: CATALOG_PATH },
      ...types.map((t) => ({ label: t.labelPlural, link: catalogTypePath(t.value) })),
    ],
    addYours: { label: 'Add your integration', link: GET_FEATURED_PATH },
  }
}

/**
 * The catalog rail as StarlightPage sidebar config. Catalog pages pass it to
 * StarlightPage, which marks the current link from the page's path.
 */
export function buildCatalogSidebarItems(cards: CatalogCardModel[]) {
  const { browse, addYours } = catalogLinks(cards)
  return [{ label: 'Integrations', items: browse }, addYours]
}

/**
 * The catalog rail in Starlight route-data form, for pages that render inside
 * it without being catalog pages (route-middleware.ts): "Add your integration",
 * and the integration docs pages, whose dialog sits over their type's catalog.
 * `currentPath` (site-relative) is the link to mark current.
 */
export async function buildIntegrationsSidebar(currentPath: string): Promise<SidebarEntry[]> {
  const { browse, addYours } = catalogLinks(await loadCatalogCards())
  const link = ({ label, link: href }: { label: string; link: string }): SidebarEntry => ({
    type: 'link',
    label,
    href: pathWithBase(href),
    isCurrent: href === currentPath,
    badge: undefined,
    attrs: {},
  })

  return [
    { type: 'group', label: 'Integrations', collapsed: false, badge: undefined, entries: browse.map(link) },
    link(addYours),
  ]
}
