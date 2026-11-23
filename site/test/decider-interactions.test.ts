import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../dist/decider/index.html', import.meta.url), 'utf8')
const sourceDocument = new JSDOM(html).window.document
const interactionScript =
  Array.from(sourceDocument.querySelectorAll<HTMLScriptElement>('script[type="module"]')).find((script) =>
    script.textContent.includes('data-decider-example-selector')
  )?.textContent ?? ''

function loadPage(beforeInit?: (window: JSDOM['window']) => void, url = 'https://example.test/decider/') {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url,
  })
  const { window } = dom

  beforeInit?.(window)
  window.eval(interactionScript)
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'))

  return { dom, window }
}

function shapeLinks(window: JSDOM['window']) {
  return Array.from(window.document.querySelectorAll<HTMLAnchorElement>('[data-decider-shape-link]'))
}

function examplePanels(window: JSDOM['window']) {
  return Array.from(window.document.querySelectorAll<HTMLElement>('[data-decider-example]'))
}

describe('Decider landing page interactions', () => {
  it('switches the example when an answer shape is selected', () => {
    const { window } = loadPage()
    const links = shapeLinks(window)
    const panels = examplePanels(window)

    expect(interactionScript).not.toBe('')
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual(['true', null, null])
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true, true])

    links[1].click()

    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'true', null])
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false, true])
    expect(window.location.hash).toBe('#decider-example-noul')
    expect(panels[1].textContent).toContain('Is this request urgent?')
    expect(panels[1].textContent).toContain('0.94')

    links[2].click()

    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, null, 'true'])
    expect(panels.map((panel) => panel.hidden)).toEqual([true, true, false])
    expect(panels[2].textContent).toContain('Order #4421 never arrived')
    expect(panels[2].textContent).toContain('1.71')
  })

  it('opens the example selected by the URL hash', () => {
    const { window } = loadPage(undefined, 'https://example.test/decider/#decider-example-score')

    expect(shapeLinks(window).map((link) => link.getAttribute('aria-current'))).toEqual([null, null, 'true'])
    expect(examplePanels(window).map((panel) => panel.hidden)).toEqual([true, true, false])
  })

  it('initializes only once when the page-load event fires again', () => {
    let listenerSpy: ReturnType<typeof vi.spyOn> | undefined
    const { window } = loadPage((pageWindow) => {
      listenerSpy = vi.spyOn(pageWindow.HTMLAnchorElement.prototype, 'addEventListener')
    })
    const selector = window.document.querySelector<HTMLElement>('[data-decider-example-selector]')

    expect(selector?.dataset.enhanced).toBe('true')
    const initialClickListeners = listenerSpy?.mock.calls.filter(([eventName]) => eventName === 'click').length ?? 0
    expect(initialClickListeners).toBe(shapeLinks(window).length)

    window.document.dispatchEvent(new window.Event('astro:page-load'))

    expect(listenerSpy?.mock.calls.filter(([eventName]) => eventName === 'click')).toHaveLength(initialClickListeners)
    listenerSpy?.mockRestore()
  })
})
