import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLastModMap, getGitPrefix } from '../src/util/git-dates'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}))

beforeEach(() => {
  execFileSyncMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildLastModMap', () => {
  it('keeps the newest commit date for each file', () => {
    execFileSyncMock.mockReturnValue(
      [
        '2026-10-28T12:00:00-04:00',
        '',
        'site/src/content/docs/first.mdx',
        'site/src/content/docs/shared.mdx',
        '',
        '2026-10-01T09:30:00-04:00',
        '',
        'site/src/content/docs/shared.mdx',
        'site/src/content/docs/older.mdx',
        '',
      ].join('\n')
    )

    expect(buildLastModMap('site/src/content/docs')).toEqual(
      new Map([
        ['site/src/content/docs/first.mdx', '2026-10-28T12:00:00-04:00'],
        ['site/src/content/docs/shared.mdx', '2026-10-28T12:00:00-04:00'],
        ['site/src/content/docs/older.mdx', '2026-10-01T09:30:00-04:00'],
      ])
    )
  })

  it('returns an empty map when git is unavailable', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    execFileSyncMock.mockImplementation(() => {
      throw new Error('git unavailable')
    })

    expect(buildLastModMap('site/src/content/docs')).toEqual(new Map())
    expect(warning).toHaveBeenCalledWith('[git-dates] Failed to build lastmod map:', 'git unavailable')
  })
})

describe('getGitPrefix', () => {
  it('trims the prefix reported by git', () => {
    execFileSyncMock.mockReturnValue('site/nested/\n')

    expect(getGitPrefix()).toBe('site/nested/')
  })

  it('returns an empty prefix when git is unavailable', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('git unavailable')
    })

    expect(getGitPrefix()).toBe('')
  })
})
