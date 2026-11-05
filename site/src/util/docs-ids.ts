import { getCollection } from 'astro:content'

// Built once per build, not once per page: Head.astro runs for every route and
// only needs membership checks against the routes with raw markdown twins.
let docsCached: Promise<Set<string>> | undefined
let sampleGuidesCached: Promise<Set<string>> | undefined

/** The set of docs content-collection ids, cached across pages within a build. */
export function getDocsIds(): Promise<Set<string>> {
  docsCached ??= getCollection('docs').then((docs) => new Set(docs.map((doc) => doc.id)))
  return docsCached
}

/** The set of generated sample guide route ids, cached across pages within a build. */
export function getSampleGuideRouteIds(): Promise<Set<string>> {
  sampleGuidesCached ??= getCollection('sampleGuides').then(
    (guides) => new Set(guides.map((guide) => `examples/${guide.data.slug}`))
  )
  return sampleGuidesCached
}
