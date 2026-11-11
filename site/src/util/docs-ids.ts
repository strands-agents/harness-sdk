import { getCollection } from 'astro:content'

// Built once per build, not once per page: Head.astro runs for every route and
// uses these for markdown twin checks and breadcrumb names.
let docsCached: Promise<Map<string, string>> | undefined
let sampleGuidesCached: Promise<Set<string>> | undefined

/** Docs content-collection ids mapped to page titles, cached across pages within a build. */
export function getDocsIds(): Promise<Map<string, string>> {
  docsCached ??= getCollection('docs').then((docs) => new Map(docs.map((doc) => [doc.id, doc.data.title])))
  return docsCached
}

/** The set of generated sample guide route ids, cached across pages within a build. */
export function getSampleGuideRouteIds(): Promise<Set<string>> {
  sampleGuidesCached ??= getCollection('sampleGuides').then(
    (guides) => new Set(guides.map((guide) => `examples/${guide.data.slug}`))
  )
  return sampleGuidesCached
}
