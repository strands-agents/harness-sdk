import type { CollectionEntry } from 'astro:content'
import { pathWithBase } from './links'
import { languageLabel } from './source-links'

export type SampleGuideEntry = CollectionEntry<'sampleGuides'>

export function sortSampleGuides(guides: SampleGuideEntry[]): SampleGuideEntry[] {
  return [...guides].sort((left, right) => left.data.order - right.data.order)
}

export function sampleGuidePath(guide: SampleGuideEntry): string {
  return `/examples/${guide.data.slug}/`
}

export function buildSampleGuideSidebar(guides: SampleGuideEntry[]) {
  const languages = new Map<string, Map<string, { label: string; guides: SampleGuideEntry[] }>>()

  for (const guide of guides) {
    let categories = languages.get(guide.data.language)
    if (!categories) {
      categories = new Map()
      languages.set(guide.data.language, categories)
    }

    let category = categories.get(guide.data.category)
    if (!category) {
      category = { label: guide.data.categoryLabel, guides: [] }
      categories.set(guide.data.category, category)
    }
    category.guides.push(guide)
  }

  return [...languages].map(([language, categories]) => {
    return {
      label: languageLabel(language),
      collapsed: false,
      items: [...categories.values()].map((category) => ({
        label: category.label,
        collapsed: false,
        items: category.guides.map((guide) => ({
          label: guide.data.title,
          link: sampleGuidePath(guide),
        })),
      })),
    }
  })
}

export function isSampleGuidePath(pathname: string): boolean {
  const root = pathWithBase('/examples')
  return pathname === root || pathname.startsWith(`${root}/`)
}
