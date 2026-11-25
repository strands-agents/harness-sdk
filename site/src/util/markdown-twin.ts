import { getDocsIds, getSampleGuideRouteIds } from './docs-ids'

/** The route fields that decide whether a Starlight page has a raw markdown twin. */
export interface MarkdownTwinEntry {
  id: string
  data: { externalDocs?: { status?: string } }
}

/**
 * The `/index.md` twin of a Starlight page, or null when the page has none.
 *
 * Twins exist for generated sample guides and for docs pages, except imported
 * docs still in preview (src/pages/[...slug]/index.md.ts and
 * src/pages/examples/[...sample]/index.md.ts serve them). The head's
 * `rel="alternate"` link and the page actions row both use this, so they agree.
 */
export function markdownTwinHref(
  entry: MarkdownTwinEntry,
  docIds: { has(id: string): boolean },
  sampleGuideRouteIds: { has(id: string): boolean },
  base: string
): string | null {
  const hasTwin =
    sampleGuideRouteIds.has(entry.id) || (docIds.has(entry.id) && entry.data.externalDocs?.status !== 'preview')
  return hasTwin ? `${base.replace(/\/$/, '')}/${entry.id}/index.md` : null
}

/** `markdownTwinHref` with the build's docs and sample guide ids. */
export async function getMarkdownTwinHref(entry: MarkdownTwinEntry, base: string): Promise<string | null> {
  const [docIds, sampleGuideRouteIds] = await Promise.all([getDocsIds(), getSampleGuideRouteIds()])
  return markdownTwinHref(entry, docIds, sampleGuideRouteIds, base)
}
