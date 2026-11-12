// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initHomepageCodeExamples, setHomepageCodeExampleOpen } from '../src/util/homepage-code-examples'
import { LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'

const homepageHtml = readFileSync(path.resolve('dist/index.html'), 'utf8')
let clipboardDescriptor: PropertyDescriptor | undefined

function mountHomepage(): HTMLElement {
  const homepage = new DOMParser().parseFromString(homepageHtml, 'text/html')
  const root = document.createElement('div')
  root.innerHTML = homepage.body.innerHTML
  document.body.append(root)
  return root
}

beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  localStorage.clear()
})

afterEach(() => {
  document.body.replaceChildren()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('homepage code examples', () => {
  it('keeps disclosure state, labels, and the containing card in sync', () => {
    const root = mountHomepage()
    const example = root.querySelector<HTMLElement>('[data-product-name="Strands Box"]')!
    const container = example.closest<HTMLElement>('[data-example-container]')!
    const toggle = example.querySelector<HTMLButtonElement>('[data-example-toggle]')!
    const label = example.querySelector<HTMLElement>('[data-example-toggle-label]')!
    const panel = example.querySelector<HTMLElement>('[data-example-panel]')!

    setHomepageCodeExampleOpen(example, true)
    expect(example.classList.contains('is-open')).toBe(true)
    expect(container.classList.contains('is-open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Hide code example for Strands Box')
    expect(label.textContent).toBe('Hide code')
    expect(panel.hidden).toBe(false)

    setHomepageCodeExampleOpen(example, false)
    expect(example.classList.contains('is-open')).toBe(false)
    expect(container.classList.contains('is-open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('View code example for Strands Box')
    expect(label.textContent).toBe('View code')
    expect(panel.hidden).toBe(true)
  })

  it('treats examples in the same group as an accordion', () => {
    const root = mountHomepage()
    const toolkit = root.querySelector<HTMLElement>('.toolkit')!
    const box = toolkit.querySelector<HTMLElement>('[data-product-name="Strands Box"]')!
    const decider = toolkit.querySelector<HTMLElement>('[data-product-name="Strands Decider"]')!

    initHomepageCodeExamples(toolkit)
    box.querySelector<HTMLButtonElement>('[data-example-toggle]')?.click()
    decider.querySelector<HTMLButtonElement>('[data-example-toggle]')?.click()

    expect(box.classList.contains('is-open')).toBe(false)
    expect(box.querySelector<HTMLElement>('[data-example-panel]')?.hidden).toBe(true)
    expect(box.querySelector('[data-example-toggle]')?.getAttribute('aria-expanded')).toBe('false')
    expect(decider.classList.contains('is-open')).toBe(true)
    expect(decider.querySelector<HTMLElement>('[data-example-panel]')?.hidden).toBe(false)
    expect(decider.querySelector('[data-example-toggle]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('syncs hero languages and copies the active code with feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'Python')

    const root = mountHomepage()
    const hero = root.querySelector<HTMLElement>('.banner')!
    const python = hero.querySelector<HTMLElement>('[data-example-language="Python"]')!
    const typescript = hero.querySelector<HTMLElement>('[data-example-language="TypeScript"]')!
    const terminalLabel = hero.querySelector<HTMLElement>('[data-terminal-language]')!
    const copy = hero.querySelector<HTMLButtonElement>('[data-code-copy]')!
    const copyLabel = hero.querySelector<HTMLElement>('[data-code-copy-label]')!

    initHomepageCodeExamples(hero)
    expect(python.hidden).toBe(false)
    expect(typescript.hidden).toBe(true)
    expect(terminalLabel.textContent).toBe('Python')

    window.dispatchEvent(new CustomEvent('lang-change', { detail: 'TypeScript' }))
    expect(python.hidden).toBe(true)
    expect(typescript.hidden).toBe(false)
    expect(terminalLabel.textContent).toBe('TypeScript')

    copy.click()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith(typescript.dataset.codeValue)
    expect(copy.classList.contains('is-copied')).toBe(true)
    expect(copyLabel.textContent).toBe('copied!')

    await vi.advanceTimersByTimeAsync(1600)
    expect(copy.classList.contains('is-copied')).toBe(false)
    expect(copyLabel.textContent).toBe('copy')
  })
})
