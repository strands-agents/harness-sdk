export function showFooterLanguage(root: ParentNode, lang: string): void {
  const releases = root.querySelectorAll<HTMLElement>('.site-footer [data-release-lang]')
  const match = [...releases].some((release) => release.dataset.releaseLang === lang)

  releases.forEach((release) => {
    release.hidden = match && release.dataset.releaseLang !== lang
  })
}
