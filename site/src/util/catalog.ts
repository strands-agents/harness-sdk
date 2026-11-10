/**
 * Build-time processing for catalog entries: derives the public entry model
 * shared by the catalog page and the /integrations.json feed, builds card
 * view-models on top of it, joins the bot-maintained stats file, and orders
 * the grid.
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

type CatalogLanguage = 'python' | 'typescript'

const LANGUAGES: CatalogLanguage[] = ['python', 'typescript']
const REGISTRY_LABELS = { python: 'PyPI', typescript: 'npm' } as const

/** Public fields of a catalog entry with build-time derivations applied; editorial fields stay out. */
export interface CatalogPublicModel {
  id: string
  name: string
  description: string
  integrationType: CatalogEntryData['integrationType']
  sdk: CatalogEntryData['sdk']
  maintainedBy: CatalogEntryData['maintainedBy']
  languages: Partial<Record<CatalogLanguage, { package?: string; registryUrl?: string }>>
  github: string
  /** Site-relative path of the on-site integration page, when there is one. */
  docsPath?: string
  docsUrl?: string
  addedDate: Date
}

function registryUrl(language: CatalogLanguage, pkg: string): string {
  // An extras-qualified package (`temporalio[strands-agents]`) lives on PyPI
  // under its base name. Scoped npm names (@scope/name) work unencoded.
  if (language === 'python') return `https://pypi.org/project/${pkg.replace(/\[.*\]$/, '')}/`
  return `https://www.npmjs.com/package/${pkg}`
}

export function toPublicModel(id: string, data: CatalogEntryData): CatalogPublicModel {
  // Registry URLs derive from the package name so an entry can't point its
  // PyPI/npm link at a different (or malicious) page than the package it
  // names. A language block without a package is a guide-only integration.
  const languages: CatalogPublicModel['languages'] = {}
  for (const language of LANGUAGES) {
    const block = data.languages[language]
    if (!block) continue
    languages[language] = block.package
      ? { package: block.package, registryUrl: registryUrl(language, block.package) }
      : {}
  }

  return {
    id,
    name: data.name,
    description: data.description,
    integrationType: data.integrationType,
    sdk: data.sdk,
    maintainedBy: data.maintainedBy,
    languages,
    github: data.github,
    ...(data.docsPage && { docsPath: `/${data.docsPage}/` }),
    ...(data.docsUrl && { docsUrl: data.docsUrl }),
    addedDate: data.addedDate,
  }
}

export function toCardModel(
  id: string,
  data: CatalogEntryData,
  stats: CatalogStats | undefined,
  buildDate: Date
): CatalogCardModel {
  const model = toPublicModel(id, data)
  // Guide-only languages count toward the language facet but have no registry link.
  const languages = LANGUAGES.filter((language) => model.languages[language])
  const registryLinks = languages.flatMap((language) => {
    const href = model.languages[language]?.registryUrl
    return href ? [{ label: REGISTRY_LABELS[language], href }] : []
  })

  // The displayed maintainer derives from the GitHub URL's owner segment —
  // the repo the entry links to is the source of truth for ownership.
  const maintainer = new URL(model.github).pathname.split('/')[1] ?? ''

  const badges: string[] = [...data.badges]
  if (isNew(model.addedDate, buildDate)) badges.push('new')

  const totalDownloads = (stats?.downloads?.python ?? 0) + (stats?.downloads?.typescript ?? 0)

  return {
    id,
    name: model.name,
    description: model.description,
    integrationType: model.integrationType,
    maintainedBy: model.maintainedBy,
    sdk: model.sdk,
    languages,
    // Primary link priority: on-site docs page, then the integration's own
    // Strands instructions page, then the bare GitHub repo.
    href: model.docsPath ?? model.docsUrl ?? model.github,
    external: !model.docsPath,
    github: model.github,
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
