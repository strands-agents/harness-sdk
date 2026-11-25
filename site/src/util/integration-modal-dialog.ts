/**
 * The integration docs dialog's behavior (components/IntegrationModal.astro):
 * opening docs in place from a catalog, closing, and history. Takes the window
 * so tests can drive it against the built pages in JSDOM.
 */

import { catalogUrlFor, isModalPath, titleWithHeading } from './integration-modal'
import { DEFAULT_LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY } from './language-preference'

/**
 * History state key on the entries the dialog adds. Its value counts the
 * dialog's entries up to and including this one (1 for the first docs page
 * opened over a catalog, 2 after a link or heading inside it, ...), so closing
 * can go back past all of them in one step.
 */
const DEPTH_KEY = 'integModal'

/** Full-page navigations the dialog falls back to. Tests pass their own. */
export interface Navigation {
  assign(url: string): void
  reload(): void
}

export function initIntegrationModal(
  win: Window & typeof globalThis,
  nav: Navigation = { assign: (url) => win.location.assign(url), reload: () => win.location.reload() }
): void {
  const doc = win.document
  const dialog = doc.querySelector<HTMLDialogElement>('[data-integ-modal]')
  const catalog = doc.querySelector<HTMLElement>('.cat-page')
  if (!dialog || !catalog) return

  const scroller = dialog.querySelector<HTMLElement>('[data-integ-scroll]')!
  const content = dialog.querySelector<HTMLElement>('[data-integ-content]')!
  const closeLink = dialog.querySelector<HTMLAnchorElement>('[data-integ-close]')!
  const catalogPath = catalog.dataset.catPath || win.location.pathname
  const typePaths = Object.values<string>(JSON.parse(catalog.dataset.catTypePaths || '{}'))
  const catalogTitle = titleWithHeading(doc.title, catalog.dataset.catHeading || '')

  // The docs path showing in the dialog, or null when closed.
  let openPath: string | null = dialog.open ? win.location.pathname : null
  // Whether the dialog is open as modal (the server renders it open but not modal).
  let modal = false
  // Set while a close steps back through the dialog's history entries.
  let closing = false
  let returnFocus: HTMLElement | null = null
  let loadToken = 0
  const pages = new Map<string, Promise<Document>>()

  const depth = (): number => {
    const value = win.history.state?.[DEPTH_KEY]
    return typeof value === 'number' ? value : 0
  }
  const pushEntry = (url: string) => win.history.pushState({ [DEPTH_KEY]: depth() + 1 }, '', url)
  const catalogUrl = () => catalogUrlFor(catalogPath, win.location.search)
  const modalPath = (url: URL) => url.origin === win.location.origin && isModalPath(url.pathname, typePaths)
  const innerDialogOpen = () => !!doc.querySelector('dialog[open]:not([data-integ-modal])')

  function fetchPage(path: string): Promise<Document> {
    let page = pages.get(path)
    if (!page) {
      page = win.fetch(path, { credentials: 'same-origin' }).then(async (res) => {
        if (!res.ok) throw new Error(`status=<${res.status}> | integration page failed to load`)
        return new win.DOMParser().parseFromString(await res.text(), 'text/html')
      })
      page.catch(() => pages.delete(path))
      pages.set(path, page)
    }
    return page
  }

  // Styles and module scripts the docs page needs that this page doesn't load
  // (e.g. code-block styles). Resolves once the styles apply.
  function adoptAssets(page: Document): Promise<unknown> {
    const loads: Promise<unknown>[] = []
    const has = (selector: string, attr: string, value: string | null) =>
      !!doc.querySelector(`${selector}[${attr}="${win.CSS.escape(value || '')}"]`)
    for (const link of page.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      if (has('link[rel="stylesheet"]', 'href', link.getAttribute('href'))) continue
      const copy = doc.createElement('link')
      copy.rel = 'stylesheet'
      copy.href = link.href
      loads.push(new Promise((done) => copy.addEventListener('load', done, { once: true })))
      doc.head.append(copy)
    }
    for (const script of page.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
      if (has('script', 'src', script.getAttribute('src'))) continue
      const copy = doc.createElement('script')
      copy.type = 'module'
      copy.src = script.src
      doc.head.append(copy)
    }
    return Promise.race([Promise.all(loads), new Promise((done) => win.setTimeout(done, 1500))])
  }

  // Parsed scripts don't run; recreate the inline ones in the moved content.
  // One that already ran here (e.g. a component's custom element definition)
  // is dropped: running it twice would throw.
  const ranScripts = new Set(Array.from(doc.scripts, (s) => s.textContent || ''))
  function runInlineScripts(root: HTMLElement) {
    for (const old of root.querySelectorAll('script:not([src])')) {
      const text = old.textContent || ''
      if (ranScripts.has(text)) {
        old.remove()
        continue
      }
      ranScripts.add(text)
      const script = doc.createElement('script')
      for (const { name, value } of old.attributes) script.setAttribute(name, value)
      script.textContent = text
      old.replaceWith(script)
    }
  }

  // The header's language toggle locks to a single-language page's language,
  // and that lock is built into each page. Give it the open docs page's lock,
  // or none for the catalog (`source` null), then let the toggle re-sync the
  // checked button and the docs' code tabs from the stored preference.
  function lockLanguageToggle(source: Document | null) {
    for (const btn of doc.querySelectorAll<HTMLButtonElement>('language-toggle .lang-option')) {
      const lang = btn.dataset.lang || ''
      const match = source?.querySelector<HTMLButtonElement>(
        `language-toggle .lang-option[data-lang="${win.CSS.escape(lang)}"]`
      )
      btn.disabled = !!match?.disabled
      if (btn.disabled) btn.setAttribute('aria-checked', 'false')
      if (match?.title) btn.title = match.title
      else btn.removeAttribute('title')
      if (match?.dataset.switchHref) btn.dataset.switchHref = match.dataset.switchHref
      else delete btn.dataset.switchHref
    }
    let lang = DEFAULT_LANGUAGE_LABEL
    try {
      lang = win.localStorage.getItem(LANGUAGE_STORAGE_KEY) || lang
    } catch {
      // Storage blocked: the default stands.
    }
    win.dispatchEvent(new win.CustomEvent('lang-preference-changed', { detail: { lang } }))
  }

  function show(animate: boolean) {
    if (!modal) {
      if (dialog!.open) dialog!.close()
      dialog!.showModal()
      modal = true
    }
    if (animate) {
      dialog!.classList.add('integ-modal--enter')
      dialog!.addEventListener('animationend', () => dialog!.classList.remove('integ-modal--enter'), { once: true })
    }
    scroller.focus({ preventScroll: true })
  }

  function scrollToHash(hash: string) {
    const id = decodeURIComponent(hash.slice(1))
    const target = id ? doc.getElementById(id) : null
    if (target && dialog!.contains(target)) target.scrollIntoView()
    else scroller.scrollTop = 0
  }

  async function open(url: URL, push: boolean) {
    const token = ++loadToken
    let page: Document
    try {
      page = await fetchPage(url.pathname)
      await adoptAssets(page)
    } catch {
      // Only follow the link if the reader is still waiting for it.
      if (token === loadToken) nav.assign(url.href)
      return
    }
    if (token !== loadToken) return
    const incoming = page.querySelector('[data-integ-content]')
    if (!incoming) {
      nav.assign(url.href)
      return
    }
    if (push) pushEntry(url.pathname + url.search + url.hash)
    content.replaceChildren(...Array.from(doc.importNode(incoming, true).childNodes))
    runInlineScripts(content)
    // The catalog's own title also carries id="_top", so label by text.
    dialog!.removeAttribute('aria-labelledby')
    dialog!.setAttribute('aria-label', content.querySelector('h1')?.textContent?.trim() || page.title)
    doc.title = page.title
    closeLink.href = catalogUrl()
    openPath = url.pathname
    lockLanguageToggle(page)
    show(push)
    scrollToHash(url.hash)
  }

  function hide() {
    loadToken++
    openPath = null
    modal = false
    dialog!.close()
    doc.title = catalogTitle
    lockLanguageToggle(null)
    returnFocus?.focus({ preventScroll: true })
    returnFocus = null
  }

  // Close: step back past every entry the dialog added, then show the catalog
  // there (see popstate). A directly loaded docs page with no such entries
  // becomes the catalog in place.
  function requestClose() {
    const steps = depth()
    if (steps > 0) {
      closing = true
      win.history.go(-steps)
      return
    }
    win.history.replaceState(win.history.state, '', catalogUrl())
    hide()
  }

  win.addEventListener('popstate', () => {
    const url = new URL(win.location.href)
    const wasClosing = closing
    closing = false
    if (wasClosing && modalPath(url)) {
      // Back on a directly loaded docs page: it becomes the catalog behind it.
      win.history.replaceState(win.history.state, '', catalogUrl())
      if (openPath) hide()
    } else if (url.pathname === catalogPath) {
      if (openPath) hide()
    } else if (modalPath(url)) {
      if (url.pathname !== openPath) open(url, false)
      else scrollToHash(url.hash)
    } else {
      // An entry from another document (e.g. a different catalog before a reload).
      nav.reload()
    }
  })

  // Links: catalog cards, and links inside the dialog. Modified clicks (new
  // tab, etc.) keep their browser behavior.
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
    if (!link || link.target || link.hasAttribute('download')) return
    const url = new URL(link.href)
    const inDialog = dialog.contains(link)
    const sameOrigin = url.origin === win.location.origin
    if (link === closeLink || (inDialog && sameOrigin && url.pathname === catalogPath)) {
      e.preventDefault()
      requestClose()
    } else if (inDialog && openPath && sameOrigin && url.pathname === win.location.pathname && url.hash) {
      // A heading inside the open docs: its own entry, so closing steps past it.
      e.preventDefault()
      pushEntry(url.search + url.hash)
      scrollToHash(url.hash)
    } else if (modalPath(url) && !(inDialog && url.pathname === openPath)) {
      e.preventDefault()
      if (!inDialog) returnFocus = link
      open(url, true)
    }
  })

  // Start loading a docs page as soon as its card is pointed at or focused.
  const prefetch = (e: Event) => {
    const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a[data-cat-entry]')
    if (link && modalPath(new URL(link.href))) fetchPage(new URL(link.href).pathname).catch(() => {})
  }
  catalog.addEventListener('pointerover', prefetch)
  catalog.addEventListener('focusin', prefetch)

  // Esc on keydown: without a prior user gesture Chrome closes a modal dialog
  // without a cancelable `cancel` event. An inner dialog (image zoom) takes Esc first.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openPath || e.defaultPrevented || innerDialogOpen()) return
    e.preventDefault()
    requestClose()
  })
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault()
    requestClose()
  })
  // A click on the dimmed area lands on the dialog element itself.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) requestClose()
  })

  // Loaded directly: reopen as modal, so the page behind is inert and focus
  // stays in the dialog, keeping the scroll position (e.g. from a #fragment).
  if (openPath) {
    const scrollTop = scroller.scrollTop
    show(false)
    scroller.scrollTop = scrollTop
  }
}
