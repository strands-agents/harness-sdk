/**
 * Build-time processing for catalog entries: derives card view-models from
 * collection data, joins the bot-maintained stats file, and orders the grid.
 */

import type { CatalogEntryData } from '../content.config'
import { isNew } from './new-badge'

export interface CatalogStats {
  stars?: number
  downloads?: { python?: number; typescript?: number }
}

/** Shape of src/data/catalog-stats.json — keyed by entry id (filename without .yaml). */
export type CatalogStatsFile = Record<string, CatalogStats>

export interface CatalogCardModel {
  /** Entry id (filename without .yaml) — keys the docs-drawer `?entry=` deep link. */
  id: string
  name: string
  description: string
  integrationType: CatalogEntryData['integrationType']
  maintainedBy: CatalogEntryData['maintainedBy']
  sdk: 'agents' | 'evals'
  languages: ('python' | 'typescript')[]
  href: string
  external: boolean
  github: string
  registryLinks: { label: 'PyPI' | 'npm'; href: string }[]
  maintainer: string
  featured: boolean
  badges: string[]
  stars?: number
  downloads?: number
}

export function toCardModel(
  id: string,
  data: CatalogEntryData,
  stats: CatalogStats | undefined,
  buildDate: Date
): CatalogCardModel {
  const languages: ('python' | 'typescript')[] = []
  const registryLinks: CatalogCardModel['registryLinks'] = []
  // Registry links derive from the package name so an entry can't point its
  // PyPI/npm icon at a different (or malicious) page than the package it
  // names. A language block without a package is a guide-only integration:
  // it counts toward the language facet but has no registry link to render.
  if (data.languages.python) {
    languages.push('python')
    const pkg = data.languages.python.package
    if (pkg) {
      // An extras-qualified package (`temporalio[strands-agents]`) lives on
      // PyPI under its base name.
      registryLinks.push({ label: 'PyPI', href: `https://pypi.org/project/${pkg.replace(/\[.*\]$/, '')}/` })
    }
  }
  if (data.languages.typescript) {
    languages.push('typescript')
    const pkg = data.languages.typescript.package
    if (pkg) {
      // Scoped names (@scope/name) work unencoded in npm package URLs.
      registryLinks.push({ label: 'npm', href: `https://www.npmjs.com/package/${pkg}` })
    }
  }

  // The displayed maintainer derives from the GitHub URL's owner segment —
  // the repo the entry links to is the source of truth for ownership.
  const maintainer = new URL(data.github).pathname.split('/')[1] ?? ''

  const badges: string[] = [...data.badges]
  if (isNew(data.addedDate, buildDate)) badges.push('new')

  // Primary link priority: on-site docs page, then the integration's own
  // Strands instructions page, then the bare GitHub repo.
  const docsHref = data.docsPage ? `/${data.docsPage}/` : undefined

  const totalDownloads = (stats?.downloads?.python ?? 0) + (stats?.downloads?.typescript ?? 0)

  return {
    id,
    name: data.name,
    description: data.description,
    integrationType: data.integrationType,
    maintainedBy: data.maintainedBy,
    sdk: data.sdk,
    languages,
    href: docsHref ?? data.docsUrl ?? data.github,
    external: !docsHref,
    github: data.github,
    registryLinks,
    maintainer,
    featured: data.featured,
    badges,
    ...(stats?.stars !== undefined && { stars: stats.stars }),
    ...(totalDownloads > 0 && { downloads: totalDownloads }),
  }
}

/** Featured entries first, then alphabetical by name. */
export function sortEntries(cards: CatalogCardModel[]): CatalogCardModel[] {
  return [...cards].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
