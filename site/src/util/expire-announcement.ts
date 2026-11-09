/** Replace an expired manual announcement with its blog fallback, if present. */
export function expireAnnouncement(root: Document | Element, todayIso: string): void {
  const announcement = root.querySelector<HTMLElement>('.announcement[data-expires]')
  if (!announcement || announcement.dataset.expires! >= todayIso) return

  const fallback = announcement.querySelector<HTMLTemplateElement>('.announcement__fallback')
  if (!fallback) {
    announcement.remove()
    return
  }

  announcement.removeAttribute('data-expires')
  announcement.replaceChildren(fallback.content.cloneNode(true))
}
