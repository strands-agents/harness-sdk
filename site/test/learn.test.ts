import { describe, it, expect } from 'vitest'
import { getCollection } from 'astro:content'
import {
  upcomingEvents,
  posterEvent,
  tickerEvents,
  sortCourses,
  featuredCourse,
  shelfCourses,
  formatEventDate,
  toIsoDate,
} from '../src/util/learn'
import { eventSchema, courseSchema } from '../src/content.config'
import type { Course, LearnEvent } from '../src/content.config'

const TODAY = new Date('2026-07-21T00:00:00Z')

function makeEvent(overrides: Partial<LearnEvent>): LearnEvent {
  return {
    title: 'Event',
    startDate: new Date('2026-12-01T00:00:00Z'),
    location: 'Somewhere',
    featured: false,
    ...overrides,
  }
}

function makeCourse(overrides: Partial<Course>): Course {
  return {
    title: 'Course',
    number: 1,
    status: 'available',
    description: 'A course',
    href: '/community/learning/',
    ...overrides,
  }
}

describe('upcomingEvents', () => {
  it('excludes past events and sorts ascending by start date', () => {
    const past = makeEvent({ title: 'Past', startDate: new Date('2026-01-10T00:00:00Z') })
    const near = makeEvent({ title: 'Near', startDate: new Date('2026-08-01T00:00:00Z') })
    const far = makeEvent({ title: 'Far', startDate: new Date('2026-12-01T00:00:00Z') })
    expect(upcomingEvents([far, past, near], TODAY).map((e) => e.title)).toEqual(['Near', 'Far'])
  })

  it('includes an event happening today', () => {
    const today = makeEvent({ title: 'Today', startDate: new Date('2026-07-21T00:00:00Z') })
    expect(upcomingEvents([today], TODAY)).toHaveLength(1)
  })

  it('includes a same-day event when today is mid-day UTC', () => {
    const midDay = new Date('2026-07-21T15:30:00Z')
    const sameDay = makeEvent({ title: 'SameDay', startDate: new Date('2026-07-21T00:00:00Z') })
    expect(upcomingEvents([sameDay], midDay)).toHaveLength(1)
  })

  it('includes a multi-day event still in progress', () => {
    const inProgress = makeEvent({
      title: 'InProgress',
      startDate: new Date('2026-07-19T00:00:00Z'),
      endDate: new Date('2026-07-23T00:00:00Z'),
    })
    expect(upcomingEvents([inProgress], TODAY)).toHaveLength(1)
  })

  it('returns empty array for no events', () => {
    expect(upcomingEvents([], TODAY)).toEqual([])
  })
})

describe('posterEvent', () => {
  it('prefers the soonest featured upcoming event', () => {
    const soon = makeEvent({ title: 'Soon', startDate: new Date('2026-08-01T00:00:00Z') })
    const featured = makeEvent({
      title: 'Featured',
      startDate: new Date('2026-12-01T00:00:00Z'),
      featured: true,
    })
    expect(posterEvent([soon, featured], TODAY)?.title).toBe('Featured')
  })

  it('picks the soonest featured event when two are featured', () => {
    const nearFeatured = makeEvent({
      title: 'NearFeatured',
      startDate: new Date('2026-08-01T00:00:00Z'),
      featured: true,
    })
    const farFeatured = makeEvent({
      title: 'FarFeatured',
      startDate: new Date('2026-12-01T00:00:00Z'),
      featured: true,
    })
    expect(posterEvent([farFeatured, nearFeatured], TODAY)?.title).toBe('NearFeatured')
  })

  it('falls back to the soonest upcoming event when none are featured', () => {
    const soon = makeEvent({ title: 'Soon', startDate: new Date('2026-08-01T00:00:00Z') })
    const later = makeEvent({ title: 'Later', startDate: new Date('2026-09-01T00:00:00Z') })
    expect(posterEvent([later, soon], TODAY)?.title).toBe('Soon')
  })

  it('ignores featured events that already ended', () => {
    const pastFeatured = makeEvent({
      title: 'PastFeatured',
      startDate: new Date('2026-01-10T00:00:00Z'),
      featured: true,
    })
    const soon = makeEvent({ title: 'Soon', startDate: new Date('2026-08-01T00:00:00Z') })
    expect(posterEvent([pastFeatured, soon], TODAY)?.title).toBe('Soon')
  })

  it('returns undefined when nothing is upcoming', () => {
    expect(posterEvent([], TODAY)).toBeUndefined()
  })
})

describe('tickerEvents', () => {
  it('caps at 3 by default', () => {
    const events = [8, 9, 10, 11].map((m) =>
      makeEvent({ title: `E${m}`, startDate: new Date(`2026-${String(m).padStart(2, '0')}-01T00:00:00Z`) })
    )
    expect(tickerEvents(events, TODAY).map((e) => e.title)).toEqual(['E8', 'E9', 'E10'])
  })

  it('respects a custom limit', () => {
    const events = [8, 9, 10, 11].map((m) =>
      makeEvent({ title: `E${m}`, startDate: new Date(`2026-${String(m).padStart(2, '0')}-01T00:00:00Z`) })
    )
    expect(tickerEvents(events, TODAY, 2).map((e) => e.title)).toEqual(['E8', 'E9'])
  })
})

describe('course selection', () => {
  it('sortCourses orders by number', () => {
    const c2 = makeCourse({ title: 'Two', number: 2 })
    const c1 = makeCourse({ title: 'One', number: 1 })
    expect(sortCourses([c2, c1]).map((c) => c.title)).toEqual(['One', 'Two'])
  })

  it('featuredCourse picks the lowest-numbered available course', () => {
    const dev = makeCourse({ title: 'Dev', number: 1, status: 'in-development' })
    const avail = makeCourse({ title: 'Avail', number: 2, status: 'available' })
    expect(featuredCourse([dev, avail])?.title).toBe('Avail')
  })

  it('featuredCourse returns undefined with no available courses', () => {
    const dev = makeCourse({ status: 'in-development' })
    expect(featuredCourse([dev])).toBeUndefined()
  })

  it('shelfCourses excludes the featured course and keeps the rest in order', () => {
    const avail = makeCourse({ title: 'Avail', number: 1, status: 'available' })
    const proposed = makeCourse({ title: 'Proposed', number: 3, status: 'proposed' })
    const dev = makeCourse({ title: 'Dev', number: 2, status: 'in-development' })
    const featured = featuredCourse([avail, proposed, dev])
    expect(shelfCourses([avail, proposed, dev], featured).map((c) => c.title)).toEqual(['Dev', 'Proposed'])
  })

  it('shelfCourses keeps a second available course when the first is featured', () => {
    const first = makeCourse({ title: 'First', number: 1, status: 'available' })
    const second = makeCourse({ title: 'Second', number: 2, status: 'available' })
    const featured = featuredCourse([first, second])
    expect(featured?.title).toBe('First')
    expect(shelfCourses([first, second], featured).map((c) => c.title)).toEqual(['Second'])
  })
})

describe('toIsoDate', () => {
  it('returns YYYY-MM-DD for a UTC midnight date', () => {
    expect(toIsoDate(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01')
  })
})

describe('formatEventDate', () => {
  it('formats a single-day event', () => {
    expect(formatEventDate(makeEvent({ startDate: new Date('2027-01-20T00:00:00Z') }))).toBe('Jan 20')
  })

  it('formats as single-day when endDate equals startDate', () => {
    const e = makeEvent({
      startDate: new Date('2027-01-20T00:00:00Z'),
      endDate: new Date('2027-01-20T00:00:00Z'),
    })
    expect(formatEventDate(e)).toBe('Jan 20')
  })

  it('formats as single-day when endDate has a time component on the same UTC day', () => {
    const e = makeEvent({
      startDate: new Date('2027-01-20T00:00:00Z'),
      endDate: new Date('2027-01-20T18:30:00Z'),
    })
    expect(formatEventDate(e)).toBe('Jan 20')
  })

  it('formats a same-month range with a spaced en dash', () => {
    const e = makeEvent({
      startDate: new Date('2026-12-01T00:00:00Z'),
      endDate: new Date('2026-12-05T00:00:00Z'),
    })
    expect(formatEventDate(e)).toBe('Dec 1 – 5')
  })

  it('formats a cross-month range with both months', () => {
    const e = makeEvent({
      startDate: new Date('2026-11-30T00:00:00Z'),
      endDate: new Date('2026-12-02T00:00:00Z'),
    })
    expect(formatEventDate(e)).toBe('Nov 30 – Dec 2')
  })

  it('formats a cross-year range with both months (Dec 28 – Jan 3)', () => {
    const e = makeEvent({
      startDate: new Date('2026-12-28T00:00:00Z'),
      endDate: new Date('2027-01-03T00:00:00Z'),
    })
    expect(formatEventDate(e)).toBe('Dec 28 – Jan 3')
  })

  it('does not collapse same-month cross-year range to short form', () => {
    // same month, different year — must NOT collapse to short form 'Dec 1 – 5'
    const e = makeEvent({
      startDate: new Date('2026-12-01T00:00:00Z'),
      endDate: new Date('2027-12-05T00:00:00Z'),
    })
    const formatted = formatEventDate(e)
    expect(formatted).not.toBe('Dec 1 – 5')
    expect(formatted).toBe('Dec 1 – Dec 5')
  })
})

describe('eventSchema date validation', () => {
  const base = { title: 'Event', location: 'Somewhere' }

  it('accepts a valid date range', () => {
    const result = eventSchema.safeParse({
      ...base,
      startDate: '2026-12-01',
      endDate: '2026-12-05',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a Date object for startDate', () => {
    const result = eventSchema.safeParse({
      ...base,
      startDate: new Date('2026-12-01T00:00:00Z'),
    })
    expect(result.success).toBe(true)
  })

  it('rejects an endDate before startDate', () => {
    const result = eventSchema.safeParse({
      ...base,
      startDate: '2026-12-05',
      endDate: '2026-12-01',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a numeric startDate', () => {
    const result = eventSchema.safeParse({ ...base, startDate: 20261201 })
    expect(result.success).toBe(false)
  })

  it('rejects a rolled-over calendar date (2026-02-30)', () => {
    const result = eventSchema.safeParse({ ...base, startDate: '2026-02-30' })
    expect(result.success).toBe(false)
  })

  it('rejects an impossible month (2026-13-01)', () => {
    const result = eventSchema.safeParse({ ...base, startDate: '2026-13-01' })
    expect(result.success).toBe(false)
  })

  it('rejects a locale-format date (08/04/2026)', () => {
    const result = eventSchema.safeParse({ ...base, startDate: '08/04/2026' })
    expect(result.success).toBe(false)
  })

  it('rejects a single-digit month/day (2026-8-4)', () => {
    const result = eventSchema.safeParse({ ...base, startDate: '2026-8-4' })
    expect(result.success).toBe(false)
  })
})

describe('courseSchema internalHref validation', () => {
  const base = {
    title: 'Course',
    number: 1,
    status: 'available' as const,
    description: 'A course',
  }

  it('accepts a valid site-relative href', () => {
    const result = courseSchema.safeParse({ ...base, href: '/docs/learning/lesson1-x' })
    expect(result.success).toBe(true)
  })

  it('rejects an https URL', () => {
    const result = courseSchema.safeParse({ ...base, href: 'https://evil.com' })
    expect(result.success).toBe(false)
  })

  it('rejects a protocol-relative URL (//evil.com)', () => {
    const result = courseSchema.safeParse({ ...base, href: '//evil.com' })
    expect(result.success).toBe(false)
  })

  it('rejects a backslash-escaped protocol-relative URL (/\\\\evil.com)', () => {
    const result = courseSchema.safeParse({ ...base, href: '/\\evil.com' })
    expect(result.success).toBe(false)
  })
})

describe('course lesson hrefs resolve to docs collection entries', () => {
  it('every lessons[].href in every courses/*.yaml resolves to a docs collection entry', async () => {
    const courses = await getCollection('courses')
    const docs = await getCollection('docs')

    // Build a set of valid hrefs: /docs/learning/how-agents-really-work/ etc.
    const validHrefs = new Set(docs.map((doc) => `/${doc.id}/`))

    const stale: string[] = []
    for (const course of courses) {
      for (const lesson of course.data.lessons ?? []) {
        if (!validHrefs.has(lesson.href)) {
          stale.push(`${course.id}: ${lesson.href}`)
        }
      }
    }

    expect(stale, `Stale lesson hrefs found:\n${stale.join('\n')}`).toHaveLength(0)
  })
})
