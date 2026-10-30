import { describe, expect, it } from 'vitest'
import { formatRevisionComparisons, updateExternalDocsLock } from '../../scripts/external-docs/update-lock'
import { parseExternalDocsConfig, parseExternalDocsLock } from '../../scripts/external-docs/schema'

const currentRevision = '1234567890abcdef1234567890abcdef12345678'
const nextRevision = 'abcdef1234567890abcdef1234567890abcdef12'
const config = parseExternalDocsConfig({
  schemaVersion: 1,
  products: [
    {
      id: 'strands-box',
      repository: 'https://github.com/strands-agents/box',
      ref: 'main',
      manifest: 'docs/site-manifest.json',
      routePrefix: 'docs/user-guide/box/source',
      navLabel: 'Upstream docs preview',
    },
  ],
})
const lock = parseExternalDocsLock({
  schemaVersion: 1,
  products: [{ id: 'strands-box', revision: currentRevision }],
})

describe('external docs lock updates', () => {
  it('is a no-op when the tracked ref still resolves to the locked revision', async () => {
    const result = await updateExternalDocsLock(config, lock, async (product) => {
      expect(product.ref).toBe('main')
      return currentRevision
    })

    expect(result).toEqual({ lock, changed: false, changes: [] })
  })

  it('updates only the immutable revision when the tracked ref moves', async () => {
    const result = await updateExternalDocsLock(config, lock, async () => nextRevision)

    expect(result.changed).toBe(true)
    expect(result.lock).toEqual({
      schemaVersion: 1,
      products: [{ id: 'strands-box', revision: nextRevision }],
    })
    expect(result.changes).toEqual([
      {
        id: 'strands-box',
        repository: 'https://github.com/strands-agents/box',
        previousRevision: currentRevision,
        revision: nextRevision,
      },
    ])
  })

  it('formats reviewable upstream compare links', () => {
    expect(
      formatRevisionComparisons([
        {
          id: 'strands-box',
          repository: 'https://github.com/strands-agents/box',
          previousRevision: currentRevision,
          revision: nextRevision,
        },
      ])
    ).toBe(
      `- [strands-box: \`1234567\` → \`abcdef1\`](https://github.com/strands-agents/box/compare/${currentRevision}...${nextRevision})`
    )
  })
})
