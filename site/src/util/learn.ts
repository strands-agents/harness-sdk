import type { Course, LearnEvent } from '../content.config'

// All dates treated as UTC calendar dates (YAML dates parse as UTC midnight).
// "today" is always passed explicitly so behavior is testable without mocking Date.

const MS_PER_DAY = 24 * 60 * 60 * 1000

function startOfUtcDay(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY) * MS_PER_DAY
}

/** Upcoming events (end date or start date is today or later), soonest first. */
export function upcomingEvents(events: LearnEvent[], today: Date): LearnEvent[] {
  const cutoff = startOfUtcDay(today)
  return events
    .filter((e) => startOfUtcDay(e.endDate ?? e.startDate) >= cutoff)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
}

/** Soonest featured upcoming event; falls back to soonest upcoming. */
export function posterEvent(events: LearnEvent[], today: Date): LearnEvent | undefined {
  const upcoming = upcomingEvents(events, today)
  return upcoming.find((e) => e.featured) ?? upcoming[0]
}

/** Next `limit` upcoming events for the hero ticker. */
export function tickerEvents(events: LearnEvent[], today: Date, limit = 3): LearnEvent[] {
  return upcomingEvents(events, today).slice(0, limit)
}

export function sortCourses(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => a.number - b.number)
}

export function featuredCourse(courses: Course[]): Course | undefined {
  return sortCourses(courses).find((c) => c.status === 'available')
}

export function shelfCourses(courses: Course[], featured: Course | undefined): Course[] {
  return sortCourses(courses).filter((c) => c !== featured)
}

/** YYYY-MM-DD, UTC. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })

/** "Jan 20", "Oct 20 – 21" (same month), "Nov 30 – Dec 2" (cross-month). */
export function formatEventDate(event: LearnEvent): string {
  const start = `${MONTH.format(event.startDate)} ${event.startDate.getUTCDate()}`
  if (!event.endDate || toIsoDate(event.endDate) === toIsoDate(event.startDate)) {
    return start
  }
  const sameMonth =
    event.startDate.getUTCMonth() === event.endDate.getUTCMonth() &&
    event.startDate.getUTCFullYear() === event.endDate.getUTCFullYear()
  return sameMonth
    ? `${start} – ${event.endDate.getUTCDate()}`
    : `${start} – ${MONTH.format(event.endDate)} ${event.endDate.getUTCDate()}`
}
