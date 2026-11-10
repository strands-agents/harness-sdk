import { getCollection } from 'astro:content'

/**
 * Builds a map of redirectFrom slugs to their target doc IDs from frontmatter.
 * Used at build time by Redirect404.astro and in tests.
 */
export async function buildRedirectFromMap(): Promise<Record<string, string>> {
  const docs = await getCollection('docs')
  const redirectFromMap: Record<string, string> = {}

  for (const doc of docs) {
    const redirectFrom = doc.data.redirectFrom
    if (redirectFrom && Array.isArray(redirectFrom)) {
      for (const sourceSlug of redirectFrom) {
        redirectFromMap[sourceSlug] = doc.id
      }
    }
  }

  return redirectFromMap
}
