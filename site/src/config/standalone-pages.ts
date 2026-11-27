export interface IndexableStandalonePage {
  /** Route slug without leading or trailing slashes. */
  slug: string
  /** Astro source file that owns the route. */
  pageFile: string
  /** Source paths whose newest commit date represents this route in the sitemap. */
  lastmodSources?: string[]
}

/**
 * Indexable Astro pages that do not belong to a content collection.
 *
 * Keep this list focused on route discovery. Historical URLs belong in
 * legacy-routes.json, while generated detail pages remain owned by their
 * collections.
 */
export const INDEXABLE_STANDALONE_PAGES: IndexableStandalonePage[] = [
  {
    slug: 'box',
    pageFile: 'src/pages/box.astro',
    lastmodSources: [
      'src/pages/box.astro',
      'src/pages/box/',
      'src/config/box-landing.ts',
      'src/components/box/',
      'src/components/SiteHead.astro',
      'src/components/SocialMeta.astro',
      'src/layouts/ProductLandingLayout.astro',
    ],
  },
  {
    slug: 'decider',
    pageFile: 'src/pages/decider.astro',
    lastmodSources: [
      'src/pages/decider.astro',
      'src/pages/decider/',
      'src/config/decider-landing.ts',
      'src/components/decider/',
      'src/components/SiteHead.astro',
      'src/components/SocialMeta.astro',
      'src/layouts/ProductLandingLayout.astro',
    ],
  },
  {
    slug: 'examples',
    pageFile: 'src/pages/examples.astro',
  },
  {
    slug: 'faq',
    pageFile: 'src/pages/faq.astro',
  },
  {
    slug: 'integrations',
    pageFile: 'src/pages/integrations.astro',
  },
]
