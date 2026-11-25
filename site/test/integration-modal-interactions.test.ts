import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { initIntegrationModal } from '../src/util/integration-modal-dialog'

const ORIGIN = 'https://example.test'
const CATALOG = '/docs/integrations/storage/'
const DOCS = '/docs/integrations/storage/github/'
const built = (path: string) => readFileSync(new URL(`../dist${path}index.html`, import.meta.url), 'utf8')
const catalogHtml = built(CATALOG)
const docsHtml = built(DOCS)

/**
 * A built page in JSDOM with the dialog script running. JSDOM has no <dialog>
 * methods, no fetch and no history traversal by delta, so those are stubbed:
 * `history.go(-n)` moves through a recorded stack and fires popstate.
 */
function loadPage(path: string, html: string) {
  const dom = new JSDOM(html, { url: ORIGIN + path, pretendToBeVisual: true })
  const win = dom.window as unknown as Window & typeof globalThis

  const proto = win.HTMLDialogElement.prototype as HTMLDialogElement
  Object.defineProperty(proto, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '')
    },
  })
  Object.defineProperty(proto, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open')
    },
  })
  Object.defineProperty(win.Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })

  const fetch = vi.fn(async (url: string) => ({ ok: true, text: async () => built(url) }))
  Object.defineProperty(win, 'fetch', { configurable: true, value: fetch })
  const assign = vi.fn()

  // History as a stack, so tests can step back by a delta like a browser.
  const entries: { url: string; state: unknown }[] = [{ url: ORIGIN + path, state: null }]
  let index = 0
  const realPush = win.history.pushState.bind(win.history)
  const realReplace = win.history.replaceState.bind(win.history)
  Object.defineProperty(win.history, 'pushState', {
    configurable: true,
    value(state: unknown, title: string, url: string) {
      realPush(state, title, url)
      entries.splice(index + 1, entries.length, { url: win.location.href, state })
      index++
    },
  })
  Object.defineProperty(win.history, 'replaceState', {
    configurable: true,
    value(state: unknown, title: string, url: string) {
      realReplace(state, title, url)
      entries[index] = { url: win.location.href, state }
    },
  })
  Object.defineProperty(win.history, 'go', {
    configurable: true,
    value(delta: number) {
      index = Math.max(0, Math.min(entries.length - 1, index + delta))
      const entry = entries[index]!
      realReplace(entry.state, '', entry.url)
      win.dispatchEvent(new win.PopStateEvent('popstate', { state: entry.state }))
    },
  })

  initIntegrationModal(win, { assign, reload: vi.fn() })
  const dialog = win.document.querySelector<HTMLDialogElement>('[data-integ-modal]')!
  const where = () => win.location.pathname + win.location.search + win.location.hash
  const settle = () => new Promise((done) => setTimeout(done, 0))
  const click = (el: Element) =>
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  const pressEscape = () =>
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  const card = () => win.document.querySelector<HTMLAnchorElement>(`.cat-card a[data-cat-entry][href="${DOCS}"]`)!
  const openFromCard = async () => {
    click(card())
    // Fetch, parse, and the stylesheet race in adoptAssets.
    await vi.waitFor(() => expect(dialog.open).toBe(true), { timeout: 3000 })
  }

  return {
    win,
    dialog,
    where,
    settle,
    click,
    pressEscape,
    openFromCard,
    fetch,
    assign,
    entries: () => entries,
    index: () => index,
  }
}

describe('integration docs dialog', () => {
  it('opens a card in place with its own history entry', async () => {
    const page = loadPage(CATALOG, catalogHtml)
    expect(page.dialog.open).toBe(false)

    await page.openFromCard()

    expect(page.where()).toBe(DOCS)
    expect(page.dialog.querySelector('h1')?.textContent).toContain('GitHub Storage')
    expect(page.win.document.title).toMatch(/^GitHub Storage/)
    expect(page.fetch).toHaveBeenCalledWith(DOCS, expect.anything())
  })

  it('goes back to the catalog on Esc after opening a card', async () => {
    const page = loadPage(CATALOG + '?q=git', catalogHtml)
    await page.openFromCard()

    page.pressEscape()

    expect(page.index()).toBe(0)
    expect(page.where()).toBe(CATALOG + '?q=git')
    expect(page.dialog.open).toBe(false)
    expect(page.win.document.title).toMatch(/^Storage/)
  })

  it('steps back past headings opened inside the dialog in one close', async () => {
    const page = loadPage(CATALOG, catalogHtml)
    await page.openFromCard()
    const heading = Array.from(
      page.dialog.querySelectorAll<HTMLAnchorElement>('[data-integ-content] a[href^="#"]')
    ).find((a) => a.hash.length > 1)!

    page.click(heading)
    expect(page.where()).toBe(DOCS + heading.hash)
    page.click(page.dialog.querySelector('[data-integ-close]')!)

    expect(page.where()).toBe(CATALOG)
    expect(page.dialog.open).toBe(false)
    // Back at the catalog's own entry: Back now leaves the catalog instead of
    // reopening the docs.
    expect(page.index()).toBe(0)
  })

  it('turns a directly loaded docs page into its catalog on close, keeping the filters', async () => {
    const page = loadPage(DOCS + '?q=git', docsHtml)
    expect(page.dialog.open).toBe(true)

    page.click(page.dialog.querySelector('[data-integ-close]')!)

    expect(page.where()).toBe(CATALOG + '?q=git')
    expect(page.dialog.open).toBe(false)
    expect(page.entries().length).toBe(1)
  })

  it('closes when Back reaches the catalog', async () => {
    const page = loadPage(CATALOG, catalogHtml)
    await page.openFromCard()

    page.win.history.go(-1)

    expect(page.where()).toBe(CATALOG)
    expect(page.dialog.open).toBe(false)
  })

  it('does not follow a failed load the reader has moved on from', async () => {
    const tools = '/docs/integrations/tools/'
    const page = loadPage(tools, built(tools))
    const [first, second] = Array.from(
      page.win.document.querySelectorAll<HTMLAnchorElement>(`.cat-card a[data-cat-entry][href^="${tools}"]`)
    )
    let fail: (reason: Error) => void = () => {}
    page.fetch.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))

    page.click(first!)
    page.click(second!)
    await vi.waitFor(() => expect(page.dialog.open).toBe(true), { timeout: 3000 })
    fail(new Error('offline'))
    await page.settle()

    expect(page.where()).toBe(second!.pathname)
    expect(page.assign).not.toHaveBeenCalled()
  })

  it('follows the link when the reader is still waiting for a failed load', async () => {
    const page = loadPage(CATALOG, catalogHtml)
    page.fetch.mockImplementationOnce(async () => {
      throw new Error('offline')
    })

    page.click(page.win.document.querySelector<HTMLAnchorElement>(`.cat-card a[data-cat-entry][href="${DOCS}"]`)!)
    await vi.waitFor(() => expect(page.assign).toHaveBeenCalledWith(ORIGIN + DOCS))
  })
})
