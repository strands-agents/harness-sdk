// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initHomepageCodeExamples, setHomepageCodeExampleOpen } from '../src/util/homepage-code-examples'
import { LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'

function exampleMarkup(productName: string, group?: string): string {
  const groupAttribute = group ? ` data-example-group="${group}"` : ''
  return `
    <div data-example-container>
      <div
        data-example-card
        data-product-name="${productName}"
        data-example-closed-label="View code"
        ${groupAttribute}
      >
        <button
          type="button"
          aria-expanded="false"
          aria-label="View code example for ${productName}"
          data-example-toggle
        >
          <span data-example-toggle-label>View code</span>
        </button>
        <div data-example-panel hidden></div>
      </div>
    </div>
  `
}

function mount(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  document.body.append(root)
  return root
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('homepage code examples', () => {
  it('keeps disclosure state, labels, and the containing card in sync', () => {
    const root = mount(exampleMarkup('Strands Box'))
    const example = root.querySelector<HTMLElement>('[data-example-card]')!
    const container = root.querySelector<HTMLElement>('[data-example-container]')!
    const toggle = root.querySelector<HTMLButtonElement>('[data-example-toggle]')!
    const label = root.querySelector<HTMLElement>('[data-example-toggle-label]')!
    const panel = root.querySelector<HTMLElement>('[data-example-panel]')!

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
    const root = mount(exampleMarkup('Strands Box', 'tools') + exampleMarkup('Strands Decider', 'tools'))
    const examples = [...root.querySelectorAll<HTMLElement>('[data-example-card]')]

    initHomepageCodeExamples(root)
    examples[0]?.querySelector<HTMLButtonElement>('[data-example-toggle]')?.click()
    examples[1]?.querySelector<HTMLButtonElement>('[data-example-toggle]')?.click()

    expect(examples[0]?.classList.contains('is-open')).toBe(false)
    expect(examples[0]?.querySelector<HTMLElement>('[data-example-panel]')?.hidden).toBe(true)
    expect(examples[0]?.querySelector('[data-example-toggle]')?.getAttribute('aria-expanded')).toBe('false')
    expect(examples[1]?.classList.contains('is-open')).toBe(true)
    expect(examples[1]?.querySelector<HTMLElement>('[data-example-panel]')?.hidden).toBe(false)
    expect(examples[1]?.querySelector('[data-example-toggle]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('syncs hero languages and copies the active code with feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'Python')

    const root = mount(`
      <div data-example-card data-code-language-sync>
        <div data-code-terminal>
          <span data-terminal-language>TypeScript</span>
          <button type="button" data-code-copy>
            <span data-code-copy-label>copy</span>
          </button>
          <div data-example-language="Python" data-code-value="python_code" hidden></div>
          <div data-example-language="TypeScript" data-code-value="typescript_code"></div>
        </div>
      </div>
    `)
    const python = root.querySelector<HTMLElement>('[data-example-language="Python"]')!
    const typescript = root.querySelector<HTMLElement>('[data-example-language="TypeScript"]')!
    const terminalLabel = root.querySelector<HTMLElement>('[data-terminal-language]')!
    const copy = root.querySelector<HTMLButtonElement>('[data-code-copy]')!
    const copyLabel = root.querySelector<HTMLElement>('[data-code-copy-label]')!

    initHomepageCodeExamples(root)
    expect(python.hidden).toBe(false)
    expect(typescript.hidden).toBe(true)
    expect(terminalLabel.textContent).toBe('Python')

    window.dispatchEvent(new CustomEvent('lang-change', { detail: 'TypeScript' }))
    expect(python.hidden).toBe(true)
    expect(typescript.hidden).toBe(false)
    expect(terminalLabel.textContent).toBe('TypeScript')

    copy.click()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('typescript_code')
    expect(copy.classList.contains('is-copied')).toBe(true)
    expect(copyLabel.textContent).toBe('copied!')

    await vi.advanceTimersByTimeAsync(1600)
    expect(copy.classList.contains('is-copied')).toBe(false)
    expect(copyLabel.textContent).toBe('copy')
  })
})
