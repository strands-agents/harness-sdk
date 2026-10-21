import { pathWithBase } from './links'
import {
  defaultSampleDetail,
  getSampleDetailPath,
  getSampleLanguageLabel,
  sampleCategories,
  sampleDetails,
  type SampleDetail,
} from './sample-details'
import type { ProductNavItem } from './product-nav'

const preferredLanguageOrder = ['typescript', 'python']

function languageId(language: string): string {
  return language.trim().toLowerCase()
}

function languageOrder(language: string): number {
  const index = preferredLanguageOrder.indexOf(language)
  return index === -1 ? preferredLanguageOrder.length : index
}

export const defaultSample = defaultSampleDetail

export function getSamplePagePath(sample: SampleDetail): string {
  const samplePath = getSampleDetailPath(sample.id)
  if (!samplePath) throw new Error(`Could not resolve the generated route for ${sample.id}.`)
  return samplePath
}

function orderedLanguages(): string[] {
  return [...new Set(sampleCategories.map((category) => languageId(category.language)))].sort(
    (left, right) => languageOrder(left) - languageOrder(right) || left.localeCompare(right)
  )
}

function samplesForCategory(language: string, categoryId: string): SampleDetail[] {
  return sampleDetails.filter(
    (sample) => languageId(sample.metadata.language) === language && sample.metadata.category === categoryId
  )
}

export function buildSampleSidebar() {
  return orderedLanguages().flatMap((language) =>
    sampleCategories
      .filter((category) => languageId(category.language) === language)
      .map((category) => ({
        label: category.label,
        collapsed: false,
        items: samplesForCategory(language, category.id).map((sample) => ({
          label: sample.metadata.title,
          // Starlight applies Astro's configured base path while normalizing
          // sidebar entries. Supplying an already-prefixed link here would
          // duplicate the base in preview deployments.
          link: getSamplePagePath(sample),
        })),
      }))
      .filter((category) => category.items.length > 0)
  )
}

export function buildSampleMobileNav(): ProductNavItem[] {
  return orderedLanguages().map((language) => ({
    type: 'group',
    label: getSampleLanguageLabel(language),
    items: sampleCategories
      .filter((category) => languageId(category.language) === language)
      .map((category) => ({
        type: 'group' as const,
        label: category.label,
        items: samplesForCategory(language, category.id).map((sample) => ({
          type: 'link' as const,
          label: sample.metadata.title,
          href: pathWithBase(getSamplePagePath(sample)),
        })),
      }))
      .filter((category) => category.items.length > 0),
  }))
}

function sampleForPagePath(currentPath: string): SampleDetail | undefined {
  const normalized = `/${currentPath.replace(/^\/+|\/+$/g, '')}/`
  return sampleDetails.find((sample) => getSamplePagePath(sample) === normalized)
}

export function getSampleLanguageSwitchPath(currentPath: string, targetLanguage: string): string | undefined {
  const currentSample = sampleForPagePath(currentPath)
  if (!currentSample) return undefined

  const normalizedTarget = languageId(targetLanguage)
  if (languageId(currentSample.metadata.language) === normalizedTarget) return undefined

  const candidates = sampleDetails.filter((sample) => languageId(sample.metadata.language) === normalizedTarget)
  if (candidates.length === 0) return undefined

  const counterpartSuffix = currentSample.slug.split('/').slice(1).join('/')
  const counterpart = candidates.find((sample) => sample.slug.split('/').slice(1).join('/') === counterpartSuffix)
  return getSamplePagePath(counterpart ?? candidates[0]!)
}

export function getSamplePagination(sample: SampleDetail) {
  const language = languageId(sample.metadata.language)
  const samples = sampleDetails.filter((candidate) => languageId(candidate.metadata.language) === language)
  const index = samples.findIndex((candidate) => candidate.id === sample.id)
  if (index === -1) return { prev: false as const, next: false as const }

  const prev = samples[index - 1]
  const next = samples[index + 1]
  return {
    prev: prev ? { label: prev.metadata.title, link: pathWithBase(getSamplePagePath(prev)) } : (false as const),
    next: next ? { label: next.metadata.title, link: pathWithBase(getSamplePagePath(next)) } : (false as const),
  }
}
