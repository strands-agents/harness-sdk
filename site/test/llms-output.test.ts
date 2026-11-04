import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('llms.txt output', () => {
  it('omits sidebar sections whose pages are all excluded from publication', () => {
    const llms = readFileSync(new URL('../dist/llms.txt', import.meta.url), 'utf8')

    expect(llms).not.toMatch(/^## Box$/m)
    expect(llms).not.toContain('/docs/user-guide/box/')
  })
})
