import fs from 'node:fs'
import path from 'node:path'

export interface GeneratedExternalDocsNavigation {
  schemaVersion: 1
  product: {
    id: string
    name: string
    status: 'preview' | 'stable'
  }
  revision: string
  routePrefix: string
  label: string
  groups: Array<{
    label: string
    items: Array<{
      label: string
      slug: string
    }>
  }>
}

export function loadGeneratedExternalDocsNavigation(
  externalDocsDir: string,
  productId: string
): GeneratedExternalDocsNavigation | null {
  const navigationPath = path.join(externalDocsDir, productId, 'navigation.json')
  if (!fs.existsSync(navigationPath)) return null

  const parsed: unknown = JSON.parse(fs.readFileSync(navigationPath, 'utf-8'))
  if (!isGeneratedNavigation(parsed, productId)) {
    throw new Error(`${navigationPath} is not valid generated external docs navigation`)
  }
  return parsed
}

function isGeneratedNavigation(input: unknown, productId: string): input is GeneratedExternalDocsNavigation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  if (
    value.schemaVersion !== 1 ||
    typeof value.revision !== 'string' ||
    typeof value.routePrefix !== 'string' ||
    typeof value.label !== 'string'
  ) {
    return false
  }
  if (!isProduct(value.product, productId) || !Array.isArray(value.groups)) return false
  return value.groups.every(isGroup)
}

function isProduct(input: unknown, productId: string): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  return (
    value.id === productId &&
    typeof value.name === 'string' &&
    (value.status === 'preview' || value.status === 'stable')
  )
}

function isGroup(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  return typeof value.label === 'string' && Array.isArray(value.items) && value.items.every(isItem)
}

function isItem(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  return typeof value.label === 'string' && typeof value.slug === 'string'
}
