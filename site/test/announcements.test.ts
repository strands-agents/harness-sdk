import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import { activeAnnouncement, announcementExpires, ANNOUNCEMENT_DAYS } from '../src/util/announcements'
import { announcementSchema } from '../src/content.config'
import type { Announcement } from '../src/content.config'

function makeAnnouncement(date: string, title = 'Announcement'): Announcement {
  return { title, href: '/blog/post/', linkText: 'Learn more', date: new Date(`${date}T00:00:00Z`) }
}

const day = (iso: string) => new Date(`${iso}T12:00:00Z`)

describe('announcementExpires', () => {
  it('is the last day of the window', () => {
    expect(ANNOUNCEMENT_DAYS).toBe(14)
    expect(announcementExpires(makeAnnouncement('2026-10-01'))).toBe('2026-10-14')
  })

  it('uses expires when set', () => {
    const announcement = { ...makeAnnouncement('2026-10-01'), expires: new Date('2026-10-19T00:00:00Z') }
    expect(announcementExpires(announcement)).toBe('2026-10-19')
    expect(activeAnnouncement([announcement], day('2026-10-19'))).toBe(announcement)
    expect(activeAnnouncement([announcement], day('2026-10-20'))).toBeUndefined()
  })
})

describe('activeAnnouncement', () => {
  const announcement = makeAnnouncement('2026-10-01')

  it('shows the announcement through its last day', () => {
    expect(activeAnnouncement([announcement], day('2026-10-01'))).toBe(announcement)
    expect(activeAnnouncement([announcement], day('2026-10-14'))).toBe(announcement)
  })

  it('hides the announcement after two weeks', () => {
    expect(activeAnnouncement([announcement], day('2026-10-15'))).toBeUndefined()
  })

  it('hides announcements dated in the future', () => {
    expect(activeAnnouncement([announcement], day('2026-09-30'))).toBeUndefined()
  })

  it('restarts the window when the date is bumped', () => {
    const updated = { ...announcement, date: new Date('2026-10-10T00:00:00Z') }
    expect(activeAnnouncement([updated], day('2026-10-20'))).toBe(updated)
  })

  it('prefers the most recent active announcement', () => {
    const newer = makeAnnouncement('2026-10-05', 'Newer')
    expect(activeAnnouncement([announcement, newer], day('2026-10-06'))).toBe(newer)
  })

  it('returns undefined when there are no announcements', () => {
    expect(activeAnnouncement([], day('2026-10-01'))).toBeUndefined()
  })
})

describe('announcementSchema', () => {
  it('defaults linkText and rejects invalid dates', () => {
    expect(announcementSchema.parse({ title: 't', href: '/x/', date: '2026-10-01' })).toEqual({
      title: 't',
      href: '/x/',
      linkText: 'Learn more',
      date: new Date('2026-10-01T00:00:00Z'),
    })
    expect(announcementSchema.safeParse({ title: 't', href: '/x/', date: '2026-02-30' }).success).toBe(false)
  })

  it('rejects expires before date', () => {
    const result = announcementSchema.safeParse({ title: 't', href: '/x/', date: '2026-10-05', expires: '2026-10-04' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['expires'])
  })

  it('validates every announcement in the collection', async () => {
    const entries = await getCollection('announcements')
    for (const entry of entries) {
      expect(announcementSchema.safeParse(entry.data).success).toBe(true)
    }
  })
})
