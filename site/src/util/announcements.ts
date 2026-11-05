import type { Announcement } from '../content.config'
import { toIsoDate } from './learn'

/** Days an announcement stays up after its `date`. */
export const ANNOUNCEMENT_DAYS = 14

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Last day (YYYY-MM-DD, UTC) the announcement is shown. */
export function announcementExpires(announcement: Announcement): string {
  if (announcement.expires) return toIsoDate(announcement.expires)
  return toIsoDate(new Date(announcement.date.getTime() + (ANNOUNCEMENT_DAYS - 1) * MS_PER_DAY))
}

/** Most recent announcement still inside its window, if any. */
export function activeAnnouncement(announcements: Announcement[], today: Date): Announcement | undefined {
  const todayIso = toIsoDate(today)
  return announcements
    .filter((a) => toIsoDate(a.date) <= todayIso && announcementExpires(a) >= todayIso)
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0]
}
