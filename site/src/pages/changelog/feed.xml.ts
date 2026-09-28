import type { APIRoute } from 'astro'
import rss from '@astrojs/rss'
import { getReleases, releaseSlug, HIDDEN_AREAS } from '../../util/changelog'
import { streamLabel } from '../../config/changelog'
import { pathWithBase } from '../../util/links'

export const GET: APIRoute = async (context) => {
  const releases = await getReleases()
  return rss({
    title: 'Strands Agents Changelog',
    description: 'Releases across the Strands Agents Strands harness and Evals SDKs.',
    site: context.site!,
    items: releases.map((r) => ({
      title: `${streamLabel(r.data.sdk, r.data.language)} v${r.data.version}`,
      pubDate: r.data.date,
      description:
        r.data.highlights ||
        r.data.entries.slice(0, 5).map((e) => `• ${e.title}`).join('\n') ||
        `Release ${r.data.version}`,
      // Link to the on-site detail page (the canonical home for the release),
      // not the GitHub release — keeps readers on the docs site.
      link: pathWithBase(`/changelog/${releaseSlug(r)}/`),
      categories: [...new Set(r.data.entries.flatMap((e) => e.areas))].filter((a) => !HIDDEN_AREAS.has(a)),
    })),
    customData: '<language>en-us</language>',
  })
}
