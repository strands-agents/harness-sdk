import type { CollectionEntry } from 'astro:content'

export const isPublishedDoc = ({ data }: CollectionEntry<'docs'>): boolean =>
  !data.draft && data.externalDocs?.status !== 'preview'
