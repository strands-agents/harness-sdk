import type { Announcement } from '../content.config'
import type { BlogPost } from './blog'
import { toIsoDate } from './learn'

/** Days an announcement stays up after its `date`. */
export const ANNOUNCEMENT_DAYS = 14

const MS_PER_DAY = 24 * 60 * 60 * 1000

type BannerBlogPost = Pick<BlogPost, 'id'> & {
  data: Pick<BlogPost['data'], 'date' | 'title'>
}

export interface HomepageBanner {
  title: string
  href: string
  linkText: string
  date: Date
  expires?: string
}

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

/** Convert the newest blog post into homepage banner content. */
export function latestPostBanner(posts: BannerBlogPost[]): HomepageBanner | undefined {
  const latestPost = [...posts].sort((a, b) => b.data.date.getTime() - a.data.date.getTime())[0]
  if (!latestPost) return undefined

  return {
    title: latestPost.data.title,
    href: `/blog/${latestPost.id}/`,
    linkText: 'Read the post',
    date: latestPost.data.date,
  }
}

/** Newest blog post not already promoted by the homepage banner. */
export function homepageCommunityPost(posts: BannerBlogPost[], bannerHref?: string): BannerBlogPost | undefined {
  return [...posts]
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
    .find((post) => `/blog/${post.id}/` !== bannerHref)
}

/**
 * Use the newest blog post unless an active manual announcement is at least
 * as recent. An explicit expiry pins the manual announcement through that day.
 */
export function homepageBanner(
  announcements: Announcement[],
  posts: BannerBlogPost[],
  today: Date
): HomepageBanner | undefined {
  const manual = activeAnnouncement(announcements, today)
  const latestPost = latestPostBanner(posts)

  if (manual && (manual.expires || !latestPost || toIsoDate(manual.date) >= toIsoDate(latestPost.date))) {
    return {
      title: manual.title,
      href: manual.href,
      linkText: manual.linkText,
      date: manual.date,
      expires: announcementExpires(manual),
    }
  }

  return latestPost
}
