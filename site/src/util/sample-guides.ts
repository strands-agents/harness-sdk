import type { CollectionEntry } from 'astro:content'
import { pathWithBase } from './links'
import { languageLabel } from './source-links'

export type SampleGuideEntry = CollectionEntry<'sampleGuides'>
export interface SampleGuideFamily {
  key: string
  primary: SampleGuideEntry
  guides: SampleGuideEntry[]
}
export interface SampleGuideCategory {
  key: string
  label: string
  description?: string
  order: number
  families: SampleGuideFamily[]
}

export function sortSampleGuides(guides: SampleGuideEntry[]): SampleGuideEntry[] {
  return [...guides].sort((left, right) => left.data.order - right.data.order)
}

export function groupSampleGuideFamilies(guides: SampleGuideEntry[]): SampleGuideFamily[] {
  const families = new Map<string, SampleGuideFamily>()
  for (const guide of sortSampleGuides(guides)) {
    const key = guide.data.family ?? guide.data.slug
    const family = families.get(key)
    if (family) {
      family.guides.push(guide)
      continue
    }
    families.set(key, { key, primary: guide, guides: [guide] })
  }
  return [...families.values()]
}

export function groupSampleGuideCategories(guides: SampleGuideEntry[]): SampleGuideCategory[] {
  const categories = new Map<string, SampleGuideCategory>()

  for (const family of groupSampleGuideFamilies(guides)) {
    const primary = family.primary
    const collection = primary.data.collection
    const key = collection?.id ?? primary.data.category
    let category = categories.get(key)
    if (!category) {
      const newCategory: SampleGuideCategory = {
        key,
        label: collection?.label ?? primary.data.categoryLabel,
        ...(collection?.description ? { description: collection.description } : {}),
        order: collection?.order ?? primary.data.order,
        families: [],
      }
      categories.set(key, newCategory)
      category = newCategory
    }
    category.families.push(family)
  }

  return [...categories.values()].sort((left, right) => left.order - right.order)
}

export function sampleGuidePath(guide: SampleGuideEntry): string {
  return `/examples/${guide.data.slug}/`
}

export function sampleGuideLanguageFromPath(pathname: string): string | undefined {
  const root = pathWithBase('/examples').replace(/\/$/, '')
  if (!pathname.startsWith(`${root}/`)) return undefined

  const language = pathname
    .slice(root.length + 1)
    .split('/')[0]
    ?.toLowerCase()
  return language === 'python' || language === 'typescript' ? language : undefined
}

export function sampleGuideSwitchPath(
  guides: SampleGuideEntry[],
  currentSlug: string,
  targetLanguage: string
): string | undefined {
  const current = guides.find((guide) => guide.data.slug === currentSlug)
  if (!current || current.data.language === targetLanguage) return undefined

  const catalogGuides = guides.filter((guide) => guide.data.catalogMode === current.data.catalogMode)
  if (current.data.catalogMode === 'legacy') {
    const segments = current.data.slug.split('/')
    if (segments.length < 2) return undefined
    const counterpartSlug = [targetLanguage, ...segments.slice(1)].join('/')
    const target =
      catalogGuides.find((guide) => guide.data.slug === counterpartSlug) ??
      sortSampleGuides(catalogGuides).find((guide) => guide.data.language === targetLanguage)
    return target ? sampleGuidePath(target) : undefined
  }

  const target = current.data.family
    ? catalogGuides.find((guide) => guide.data.language === targetLanguage && guide.data.family === current.data.family)
    : undefined
  return target ? sampleGuidePath(target) : undefined
}

export function buildSampleGuideSidebar(guides: SampleGuideEntry[], currentGuide?: SampleGuideEntry) {
  const availableLanguages = new Set(guides.map((guide) => guide.data.language))
  const languageOrder: SampleGuideEntry['data']['language'][] = ['typescript', 'python']
  const languages: SampleGuideEntry['data']['language'][] = currentGuide
    ? [currentGuide.data.language]
    : languageOrder.filter((language) => availableLanguages.has(language))

  return languages.map((language) => {
    const languageGuides = sortSampleGuides(guides.filter((guide) => guide.data.language === language))

    return {
      label: languageLabel(language),
      collapsed: false,
      items: [
        { label: 'Overview', link: '/examples/' },
        ...languageGuides.map((guide) => ({
          label: guide.data.title,
          link: sampleGuidePath(guide),
        })),
      ],
    }
  })
}

export function isSampleGuidePath(pathname: string): boolean {
  const root = pathWithBase('/examples')
  return pathname === root || pathname.startsWith(`${root}/`)
}
