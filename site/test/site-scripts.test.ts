import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('site scripts', () => {
  it('pins the WebSDK version that normalizes analytics URLs', () => {
    const homepage = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')

    expect(homepage).toContain('/awsm-acslibs/1.0.3/bundle/slim/wsdk.js')
  })
})
