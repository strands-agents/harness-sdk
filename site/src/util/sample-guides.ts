import type { CollectionEntry } from 'astro:content'
import { pathWithBase } from './links'
import { languageLabel } from './source-links'

export type SampleGuideEntry = CollectionEntry<'sampleGuides'>

const preferredLanguages = ['typescript', 'python']

function languageOrder(language: string): number {
  const index = preferredLanguages.indexOf(language.toLowerCase())
  return index === -1 ? preferredLanguages.length : index
}

export function sortSampleGuides(guides: SampleGuideEntry[]): SampleGuideEntry[] {
  return [...guides].sort(
    (left, right) =>
      languageOrder(left.data.language) - languageOrder(right.data.language) ||
      left.data.categoryOrder - right.data.categoryOrder ||
      left.data.sampleOrder - right.data.sampleOrder
  )
}

export function findDefaultSampleGuide(guides: SampleGuideEntry[]): SampleGuideEntry {
  const guide = sortSampleGuides(guides)[0]
  if (!guide) throw new Error('The generated sample guide collection is empty')
  return guide
}

export function sampleGuidePath(guide: SampleGuideEntry, defaultGuide: SampleGuideEntry): string {
  return guide.id === defaultGuide.id ? '/examples/' : `/examples/${guide.data.slug}/`
}

export function sampleSourceUrl(guide: SampleGuideEntry): string {
  const sourcePath = guide.data.sourcePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `https://github.com/${guide.data.sourceRepository}/tree/${guide.data.sourceCommit}/${sourcePath}`
}

export function buildSampleGuideSidebar(guides: SampleGuideEntry[], defaultGuide: SampleGuideEntry) {
  const sorted = sortSampleGuides(guides)
  const languages = [...new Set(sorted.map((guide) => guide.data.language))]
  return languages.map((language) => {
    const languageGuides = sorted.filter((guide) => guide.data.language === language)
    const categories = [...new Set(languageGuides.map((guide) => guide.data.category))]
    return {
      label: languageLabel(language),
      collapsed: false,
      items: categories.map((category) => {
        const categoryGuides = languageGuides.filter((guide) => guide.data.category === category)
        return {
          label: categoryGuides[0]?.data.categoryLabel ?? category,
          collapsed: false,
          items: categoryGuides.map((guide) => ({
            label: guide.data.title,
            link: sampleGuidePath(guide, defaultGuide),
          })),
        }
      }),
    }
  })
}

export function sampleGuideHref(guide: SampleGuideEntry, defaultGuide: SampleGuideEntry): string {
  return pathWithBase(sampleGuidePath(guide, defaultGuide))
}

export function isSampleGuidePath(pathname: string): boolean {
  const root = pathWithBase('/examples')
  return pathname === root || pathname.startsWith(`${root}/`)
}
