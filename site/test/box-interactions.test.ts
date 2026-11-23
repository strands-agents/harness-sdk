import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../dist/box/index.html', import.meta.url), 'utf8')
const sourceDocument = new JSDOM(html).window.document
const interactionScript =
  Array.from(sourceDocument.querySelectorAll<HTMLScriptElement>('script[type="module"]')).find((script) =>
    script.textContent.includes('data-box-agent-selector')
  )?.textContent ?? ''

type IntersectionCallback = (entries: Array<{ isIntersecting: boolean }>) => void

function loadPage({ reducedMotion = false } = {}) {
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://example.test/box/',
  })
  const { window } = dom
  const observers: TestIntersectionObserver[] = []
  const animate = vi.fn(() => ({
    cancel: vi.fn(),
    finished: Promise.resolve(),
  }))

  class TestIntersectionObserver {
    callback: IntersectionCallback
    disconnected = false

    constructor(callback: IntersectionCallback) {
      this.callback = callback
      observers.push(this)
    }

    disconnect() {
      this.disconnected = true
    }

    observe() {}

    trigger(isIntersecting = true) {
      this.callback([{ isIntersecting }])
    }
  }

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: reducedMotion })),
  })
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    value: TestIntersectionObserver,
  })
  Object.defineProperty(window.Element.prototype, 'animate', {
    configurable: true,
    value: animate,
  })
  Object.defineProperty(window.Element.prototype, 'getAnimations', {
    configurable: true,
    value: vi.fn(() => []),
  })

  window.eval(interactionScript)

  return { animate, dom, observers, window }
}

function agentTabs(window: JSDOM['window']) {
  return Array.from(window.document.querySelectorAll<HTMLAnchorElement>('[data-box-agent-tab]'))
}

function agentPanels(window: JSDOM['window']) {
  return Array.from(window.document.querySelectorAll<HTMLElement>('[data-box-agent-panel]'))
}

describe('Box landing page interactions', () => {
  it('enhances the fallback agent links into keyboard-operable tabs', () => {
    const { window } = loadPage()
    const tabs = agentTabs(window)
    const panels = agentPanels(window)

    expect(interactionScript).not.toBe('')
    expect(tabs.map((tab) => tab.getAttribute('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true, true])
    expect(tabs[1].getAttribute('href')).toBe('#box-agent-panel-codex')

    tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false, true])
    expect(window.location.hash).toBe('#box-agent-panel-codex')

    tabs[1].dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))

    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
    expect(panels.map((panel) => panel.hidden)).toEqual([true, true, false])
    expect(window.document.activeElement).toBe(tabs[2])

    tabs[2].dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Home' }))
    expect(window.document.activeElement).toBe(tabs[0])

    tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'End' }))
    expect(window.document.activeElement).toBe(tabs[2])
  })

  it('reveals the example boundary once, step by step', async () => {
    const { animate, observers, window } = loadPage()
    const boundary = window.document.querySelector<HTMLElement>('[data-box-animate-boundary]')
    const steps = [
      boundary?.querySelector<HTMLElement>('.box-start__session-header'),
      boundary?.querySelector<HTMLElement>('.box-start__session-description'),
      ...(boundary?.querySelectorAll<HTMLElement>('[data-box-animate-row]') ?? []),
    ].filter((step): step is HTMLElement => step !== null && step !== undefined)

    expect(observers).toHaveLength(1)
    expect(steps.every((step) => step.style.opacity === '0')).toBe(true)

    observers[0].trigger()

    expect(boundary?.dataset.animated).toBe('true')
    expect(animate).toHaveBeenCalledTimes(steps.length)
    expect(animate.mock.calls.map((call) => call[1]?.delay)).toEqual(steps.map((_, index) => index * 110))
    expect(observers[0].disconnected).toBe(true)

    observers[0].trigger()
    expect(animate).toHaveBeenCalledTimes(steps.length)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(steps.every((step) => step.style.opacity === '1')).toBe(true)
  })

  it('keeps the selector functional and skips animation when reduced motion is requested', () => {
    const { animate, observers, window } = loadPage({ reducedMotion: true })
    const tabs = agentTabs(window)
    const panels = agentPanels(window)

    expect(observers).toHaveLength(0)
    expect(animate).not.toHaveBeenCalled()

    tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false, true])
    expect(animate).not.toHaveBeenCalled()
  })
})
