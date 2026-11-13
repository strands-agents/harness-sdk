import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('generated model info copy', () => {
  it('matches shared/model-info.json at the repository root (run `npm run prepare -w strands-ts` to refresh)', () => {
    const source = readFileSync(join(here, '../../../../shared/model-info.json'), 'utf8')
    const copy = readFileSync(join(here, '../model-info.json'), 'utf8')

    expect(copy).toBe(source)
  })
})
