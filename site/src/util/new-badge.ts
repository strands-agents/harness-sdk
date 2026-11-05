/** Window (in days) during which a dated page, sidebar group, or catalog entry counts as new. */
export const NEW_BADGE_DAYS = 30

/** The sidebar badge derived for pages and groups within the window. */
export const NEW_BADGE = { text: 'New', variant: 'tip' } as const

export function isNew(addedDate: Date, buildDate: Date): boolean {
  const ageDays = (buildDate.getTime() - addedDate.getTime()) / 86_400_000
  return ageDays >= 0 && ageDays < NEW_BADGE_DAYS
}
