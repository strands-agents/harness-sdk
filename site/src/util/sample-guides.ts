import type { CollectionEntry } from 'astro:content'
import { pathWithBase } from './links'
import { languageLabel } from './source-links'

export type SampleGuideEntry = CollectionEntry<'sampleGuides'>
export interface SampleGuideFamily {
  key: string
  primary: SampleGuideEntry
  guides: SampleGuideEntry[]
}

export function sortSampleGuides(guides: SampleGuideEntry[]): SampleGuideEntry[] {
  return [...guides].sort((left, right) => left.data.order - right.data.order)
}

export function groupSampleGuideFamilies(guides: SampleGuideEntry[]): SampleGuideFamily[] {
  const families = new Map<string, SampleGuideFamily>()
  for (const guide of sortSampleGuides(guides)) {
    const key = guide.data.family ?? guide.data.sampleId
    const family = families.get(key)
    if (family) {
      family.guides.push(guide)
      continue
    }
    families.set(key, { key, primary: guide, guides: [guide] })
  }
  return [...families.values()]
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

  const familyTarget = current.data.family
    ? guides.find((guide) => guide.data.language === targetLanguage && guide.data.family === current.data.family)
    : undefined
  const target =
    familyTarget ??
    guides.find(
      (guide) => guide.data.language === targetLanguage && current.data.variants.includes(guide.data.sampleId)
    )
  return target ? sampleGuidePath(target) : undefined
}

export function buildSampleGuideSidebar(guides: SampleGuideEntry[], currentGuide: SampleGuideEntry) {
  const categories = new Map<string, { label: string; guides: SampleGuideEntry[] }>()

  for (const guide of guides) {
    if (guide.data.language !== currentGuide.data.language || guide.data.placement !== 'featured') continue
    const primaryCollection = guide.data.collections[0]
    const categoryId = primaryCollection?.id ?? guide.data.category
    let category = categories.get(categoryId)
    if (!category) {
      category = { label: primaryCollection?.label ?? guide.data.categoryLabel, guides: [] }
      categories.set(categoryId, category)
    }
    category.guides.push(guide)
  }

  if (currentGuide.data.placement === 'reference') {
    categories.set('current-reference', {
      label: 'Reference example',
      guides: [currentGuide],
    })
  }

  if (categories.size === 0) return []

  return [
    {
      label: languageLabel(currentGuide.data.language),
      collapsed: false,
      items: [...categories.values()].map((category) => ({
        label: category.label,
        collapsed: false,
        items: category.guides.map((guide) => ({
          label: guide.data.title,
          link: sampleGuidePath(guide),
        })),
      })),
    },
  ]
}

export function isSampleGuidePath(pathname: string): boolean {
  const root = pathWithBase('/examples')
  return pathname === root || pathname.startsWith(`${root}/`)
}
