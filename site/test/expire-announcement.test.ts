// @vitest-environment jsdom
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { expireAnnouncement } from '../src/util/expire-announcement'

function buildDOM(expires?: string, includeFallback = true): Document {
  return new JSDOM(`
    <aside class="announcement"${expires ? ` data-expires="${expires}"` : ''}>
      <a class="announcement__link" href="/campaign/">Campaign</a>
      ${
        includeFallback
          ? `<template class="announcement__fallback">
               <a class="announcement__link" href="/blog/latest-post/">Latest post</a>
             </template>`
          : ''
      }
    </aside>
  `).window.document
}

describe('expireAnnouncement', () => {
  it('replaces an expired manual announcement with its blog fallback', () => {
    const document = buildDOM('2026-10-14')
    expireAnnouncement(document, '2026-10-15')

    const announcement = document.querySelector('.announcement')
    expect(announcement?.getAttribute('data-expires')).toBeNull()
    expect(announcement?.querySelector('template')).toBeNull()
    expect(announcement?.querySelector('.announcement__link')?.getAttribute('href')).toBe('/blog/latest-post/')
    expect(announcement?.textContent).toContain('Latest post')
  })

  it('keeps unexpired and dateless announcements unchanged', () => {
    const unexpired = buildDOM('2026-10-15')
    const dateless = buildDOM()

    expireAnnouncement(unexpired, '2026-10-15')
    expireAnnouncement(dateless, '2026-10-15')

    expect(unexpired.querySelector('.announcement__link')?.getAttribute('href')).toBe('/campaign/')
    expect(dateless.querySelector('.announcement__link')?.getAttribute('href')).toBe('/campaign/')
  })

  it('removes an expired announcement without a fallback', () => {
    const document = buildDOM('2026-10-14', false)
    expireAnnouncement(document, '2026-10-15')

    expect(document.querySelector('.announcement')).toBeNull()
  })
})
