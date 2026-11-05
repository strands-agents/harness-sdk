/**
 * Public JSON feed of the integrations catalog (/integrations.json) and the
 * JSON Schema it is published with (/integrations.schema.json).
 */

import { z } from 'astro/zod'
import { CATALOG_TYPES, MAINTAINED_BY_TIERS } from '../components/catalog/types'
import { toPublicModel } from './catalog'
import { pathWithBase } from './links'
import type { CatalogEntryData } from '../content.config'

// Bump on any change that can break an existing consumer (removed or renamed
// fields, narrowed values). Adding optional fields does not need a bump.
export const CATALOG_FEED_SCHEMA_VERSION = 1

export const CATALOG_FEED_PATH = '/integrations.json'
export const CATALOG_FEED_SCHEMA_PATH = '/integrations.schema.json'

const feedLanguageSchema = z.object({
  package: z.string().optional().describe('Package name as published on the registry'),
  registryUrl: z.url().optional().describe('PyPI or npm page for the package'),
})

export const catalogFeedEntrySchema = z.object({
  id: z.string().describe('Stable entry id'),
  name: z.string(),
  description: z.string(),
  integrationType: z.enum(CATALOG_TYPES.map((t) => t.value)),
  sdk: z.enum(['agents', 'evals']),
  maintainedBy: z.enum(MAINTAINED_BY_TIERS.map((t) => t.value)),
  languages: z
    .object({ python: feedLanguageSchema.optional(), typescript: feedLanguageSchema.optional() })
    .describe('Supported languages; a language without a package is covered by a guide only'),
  github: z.url(),
  docsUrl: z.url().optional().describe('On-site integration page when one exists, otherwise external docs'),
  addedDate: z.iso.date(),
})

export const catalogFeedSchema = z
  .object({
    $schema: z.url(),
    schemaVersion: z.literal(CATALOG_FEED_SCHEMA_VERSION),
    integrations: z.array(catalogFeedEntrySchema),
  })
  .meta({ title: 'Strands Agents integrations catalog' })

export type CatalogFeed = z.infer<typeof catalogFeedSchema>
type CatalogFeedEntry = z.infer<typeof catalogFeedEntrySchema>

function toFeedEntry(id: string, data: CatalogEntryData, origin: string): CatalogFeedEntry {
  const { docsPath, docsUrl, addedDate, ...rest } = toPublicModel(id, data)
  return {
    ...rest,
    docsUrl: docsPath ? `${origin}${pathWithBase(docsPath)}` : docsUrl,
    addedDate: addedDate.toISOString().slice(0, 10),
  }
}

export function buildCatalogFeed(entries: { id: string; data: CatalogEntryData }[], origin: string): CatalogFeed {
  return {
    $schema: `${origin}${pathWithBase(CATALOG_FEED_SCHEMA_PATH)}`,
    schemaVersion: CATALOG_FEED_SCHEMA_VERSION,
    integrations: entries.map((e) => toFeedEntry(e.id, e.data, origin)).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function buildCatalogFeedJsonSchema(origin: string) {
  return {
    $id: `${origin}${pathWithBase(CATALOG_FEED_SCHEMA_PATH)}`,
    // Input mode leaves additionalProperties open, so adding optional fields stays non-breaking.
    ...z.toJSONSchema(catalogFeedSchema, { io: 'input' }),
  }
}
