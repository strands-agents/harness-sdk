import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { z } from 'astro/zod'

const TAGS_YML = fileURLToPath(new URL('./tags.yml', import.meta.url))

function loadAllowedTags(): readonly string[] {
  const raw = yaml.load(fs.readFileSync(TAGS_YML, 'utf-8'))
  if (!Array.isArray(raw) || !raw.every((t): t is string => typeof t === 'string')) {
    throw new Error(`[tags] ${TAGS_YML} must be a flat YAML list of strings`)
  }
  const deduped = Array.from(new Set(raw))
  if (deduped.length !== raw.length) {
    const dupes = raw.filter((t, i) => raw.indexOf(t) !== i)
    throw new Error(`[tags] ${TAGS_YML} contains duplicate entries: ${[...new Set(dupes)].join(', ')}`)
  }
  return deduped
}

export const ALLOWED_TAGS = loadAllowedTags()

export const TagSchema = z.enum(ALLOWED_TAGS as readonly [string, ...string[]])

export type Tag = z.infer<typeof TagSchema>
