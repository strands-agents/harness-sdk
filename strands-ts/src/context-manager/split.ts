/**
 * Split large string fields out of tool result content so they are stored and previewed as plain text.
 *
 * A tool result such as `{ output: "<100 KB of stdout>", exit_code: 0 }` is stashed as one line of JSON, which makes
 * stdout unsearchable: its newlines are escaped. Any string at the top level of a text or JSON content block that
 * reaches the preview budget is split into its own stash entry, stored as raw UTF-8, and replaced in the parent by a
 * reference marker. The same split shapes the truncation preview, so the model sees the parent's structure and the
 * references it can page through.
 *
 * Only fields named `[A-Za-z0-9_-]+` are split, which keeps the stash keys path-safe; a JSON text block with a split
 * field is re-serialized compactly (`{"a":1}`), matching the Python SDK. Lengths count code points, as Python does.
 *
 * @internal
 */

import { JsonBlock, TextBlock } from '../types/messages.js'
import type { ToolResultContent } from '../types/messages.js'
import type { JSONValue } from '../types/json.js'

export const FIELD_REF_PREFIX = 'fields/'

const FIELD_NAME = /^[A-Za-z0-9_-]+$/
const FIELD_REF = new RegExp(`^${FIELD_REF_PREFIX}.+_\\d+/[A-Za-z0-9_-]+$`)

/** Stash key of a string field split out of the block stored under `parentRef`. */
export function fieldRef(parentRef: string, field: string): string {
  return `${FIELD_REF_PREFIX}${parentRef}/${field}`
}

/** Whether `reference` names a split-out string field (stored as raw text) rather than a JSON block. */
export function isFieldRef(reference: string): boolean {
  return FIELD_REF.test(reference)
}

/** Code-point length, so the split decision and marker match Python's `len()`; `.length` counts UTF-16 units. */
function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

function marker(ref: string, text: string): string {
  const lines = text.split('\n').length.toLocaleString('en-US')
  return `[ref: ${ref} (${lines} lines, ${codePointLength(text).toLocaleString('en-US')} chars)]`
}

/**
 * Split top-level strings of `threshold` chars or more out of a text or JSON content block.
 *
 * Returns the block with each split string replaced by a reference marker, plus a map of field ref to raw text.
 * Blocks with nothing to split are returned unchanged with an empty map.
 */
export function splitLargeStrings(
  item: ToolResultContent,
  parentRef: string,
  threshold: number
): { parent: ToolResultContent; fields: Record<string, string> } {
  let payload: unknown
  if (item instanceof JsonBlock) {
    payload = item.json
  } else if (item instanceof TextBlock) {
    if (codePointLength(item.text) < threshold) return { parent: item, fields: {} }
    payload = parseJsonObject(item.text)
    if (payload === null) {
      const ref = fieldRef(parentRef, 'text')
      return { parent: new TextBlock(marker(ref, item.text)), fields: { [ref]: item.text } }
    }
  } else {
    return { parent: item, fields: {} }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { parent: item, fields: {} }
  const fields: Record<string, string> = {}
  const replaced: Record<string, JSONValue> = { ...(payload as Record<string, JSONValue>) }
  for (const [key, value] of Object.entries(payload as Record<string, JSONValue>)) {
    if (typeof value === 'string' && codePointLength(value) >= threshold && FIELD_NAME.test(key)) {
      const ref = fieldRef(parentRef, key)
      fields[ref] = value
      replaced[key] = marker(ref, value)
    }
  }
  if (Object.keys(fields).length === 0) return { parent: item, fields: {} }
  if (item instanceof JsonBlock) return { parent: new JsonBlock({ json: replaced }), fields }
  return { parent: new TextBlock(JSON.stringify(replaced)), fields }
}

function parseJsonObject(text: string): Record<string, JSONValue> | null {
  if (!text.trimStart().startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, JSONValue>) : null
  } catch {
    return null
  }
}
