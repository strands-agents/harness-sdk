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
  const segments = currentSlug.replace(/^\/+|\/+$/g, '').split('/')
  if (segments.length < 2 || segments[0] === targetLanguage) return undefined

  const counterpartSlug = [targetLanguage, ...segments.slice(1)].join('/')
  const target =
    guides.find((guide) => guide.data.slug === counterpartSlug) ??
    sortSampleGuides(guides).find((guide) => guide.data.language === targetLanguage)

  return target ? sampleGuidePath(target) : undefined
}

export function buildSampleGuideSidebar(guides: SampleGuideEntry[], language: string) {
  const categories = new Map<string, { label: string; guides: SampleGuideEntry[] }>()

  for (const guide of guides) {
    if (guide.data.language !== language) continue
    let category = categories.get(guide.data.category)
    if (!category) {
      category = { label: guide.data.categoryLabel, guides: [] }
      categories.set(guide.data.category, category)
    }
    category.guides.push(guide)
  }

  if (categories.size === 0) return []

  return [
    {
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
    },
  ]
}

export function isSampleGuidePath(pathname: string): boolean {
  const root = pathWithBase('/examples')
  return pathname === root || pathname.startsWith(`${root}/`)
}
