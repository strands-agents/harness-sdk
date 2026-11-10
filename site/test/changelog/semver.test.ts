import { describe, it, expect } from 'vitest'
import { compareVersionDesc } from '../../src/util/semver'

describe('compareVersionDesc', () => {
  it('orders versions newest-first', () => {
    const sorted = ['1.0.0-rc.0', '1.0.0', '1.0.0-rc.1', '1.2.0'].sort(compareVersionDesc)
    expect(sorted).toEqual(['1.2.0', '1.0.0', '1.0.0-rc.1', '1.0.0-rc.0'])
  })
  it('compares core numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(compareVersionDesc('1.10.0', '1.9.0')).toBeLessThan(0)
  })
  it('ranks a final release above its prereleases', () => {
    expect(compareVersionDesc('1.0.0', '1.0.0-rc.5')).toBeLessThan(0)
  })
  it('orders prerelease numbers numerically (rc.10 > rc.2)', () => {
    expect(compareVersionDesc('1.0.0-rc.10', '1.0.0-rc.2')).toBeLessThan(0)
  })
  it('tolerates a leading v and equal versions', () => {
    expect(compareVersionDesc('v1.2.3', '1.2.3')).toBe(0)
  })
})
