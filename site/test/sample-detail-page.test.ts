import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { sampleDetails } from '../src/util/sample-details'

const sample = sampleDetails[0]
if (!sample) throw new Error('Expected the prototype sample snapshot')
const detailPage = readFileSync(new URL('../dist/examples/typescript/first-agent/index.html', import.meta.url), 'utf8')
const catalogPage = readFileSync(new URL('../dist/examples/index.html', import.meta.url), 'utf8')

describe('sample detail page', () => {
  it('renders the guide and key files on-site', () => {
    expect(detailPage).toContain('Create and run a minimal Strands agent')
    expect(detailPage).toContain('npx tsx src/firstAgent.ts')
    expect(detailPage).toContain('src/firstAgent.ts')
    expect(detailPage).toContain('new Agent')
    expect(detailPage).toContain('aria-labelledby="guide-tab"')
    expect(detailPage).toContain('aria-labelledby="files-tab"')
    expect(detailPage).toContain('data-pagefind-ignore')
  })

  it('pins source links to the snapshot commit', () => {
    expect(detailPage).toContain(sample.source.commit)
    expect(detailPage).not.toContain('/tree/main/typescript/01-learn/01-first-agent')
  })

  it('links the catalog card to the internal page', () => {
    expect(catalogPage).toMatch(/href="[^"]*\/examples\/typescript\/first-agent\/"/)
    expect(catalogPage).toContain('Open the TypeScript First Agent to try the on-site guide and')
  })
})
