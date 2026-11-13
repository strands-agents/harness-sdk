// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initializeTestimonialBrowsers } from '../src/util/homepage-testimonials'
import { initializeUseCases } from '../src/util/homepage-use-cases'
import { LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'

let clipboardDescriptor: PropertyDescriptor | undefined
let intersectionObserverDescriptor: PropertyDescriptor | undefined
let matchMediaDescriptor: PropertyDescriptor | undefined

function mount(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  document.body.append(root)
  return root
}

function useCaseMarkup(): string {
  return `
    <section data-use-cases>
      ${['workflows', 'assistants']
        .map(
          (name, index) => `
            <article data-use-case="${name}">
              <button
                type="button"
                class="${index === 0 ? 'is-active' : ''}"
                aria-expanded="${index === 0 ? 'true' : 'false'}"
                data-use-case-button
              >
                ${name}
              </button>
              <div
                aria-hidden="${index === 0 ? 'false' : 'true'}"
                data-use-case-panel
                ${index === 0 ? '' : 'hidden'}
              >
                <span data-code-filename="TypeScript">${name}.ts</span>
                <span data-code-filename="Python" hidden>${name}.py</span>
                <button type="button" data-code-copy>
                  <span data-code-copy-label>copy</span>
                </button>
                <div data-code-variant="TypeScript"><code>${name}_typescript</code></div>
                <div data-code-variant="Python" hidden><code>${name}_python</code></div>
              </div>
            </article>
          `
        )
        .join('')}
    </section>
  `
}

function testimonialMarkup(storyLabels = ['Story one', 'Story two', 'Story three']): string {
  const total = String(storyLabels.length).padStart(2, '0')
  return `
    <section data-testimonial-browser data-testimonial-interval="9000">
      <div data-testimonial-controls hidden>
        <span data-testimonial-current>01</span>
        <span data-testimonial-total>${total}</span>
        <button
          type="button"
          aria-label="Pause automatic story rotation"
          aria-pressed="false"
          data-testimonial-toggle
        ></button>
        <button type="button" aria-label="Previous story" data-testimonial-previous></button>
        <button type="button" aria-label="Next story" data-testimonial-next></button>
      </div>
      <div>
        ${storyLabels
          .map(
            (label, index) => `
              <article
                role="group"
                aria-label="${index + 1} of ${storyLabels.length}: ${label}"
                data-testimonial-story
              >
                ${label}
              </article>
            `
          )
          .join('')}
      </div>
      <p aria-live="polite" data-testimonial-status></p>
    </section>
  `
}

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  intersectionObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'IntersectionObserver')
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  Reflect.deleteProperty(window, 'IntersectionObserver')
  localStorage.clear()
  setReducedMotion(false)
})

afterEach(() => {
  document.dispatchEvent(new Event('astro:before-swap'))
  document.body.replaceChildren()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (intersectionObserverDescriptor) {
    Object.defineProperty(window, 'IntersectionObserver', intersectionObserverDescriptor)
  } else {
    Reflect.deleteProperty(window, 'IntersectionObserver')
  }
  if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
  else Reflect.deleteProperty(window, 'matchMedia')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('homepage use cases', () => {
  it('switches the active use case and its panel', () => {
    const root = mount(useCaseMarkup())
    const section = root.querySelector<HTMLElement>('[data-use-cases]')!
    const cases = Array.from(section.querySelectorAll<HTMLElement>('[data-use-case]'))

    initializeUseCases(section)
    cases[1]?.querySelector<HTMLButtonElement>('[data-use-case-button]')?.click()

    expect(cases[0]?.querySelector('[data-use-case-button]')?.getAttribute('aria-expanded')).toBe('false')
    expect(cases[0]?.querySelector<HTMLElement>('[data-use-case-panel]')?.hidden).toBe(true)
    expect(cases[1]?.querySelector('[data-use-case-button]')?.getAttribute('aria-expanded')).toBe('true')
    expect(cases[1]?.querySelector<HTMLElement>('[data-use-case-panel]')?.hidden).toBe(false)
  })

  it('syncs every code example with the site language event', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'Python')
    const root = mount(useCaseMarkup())
    const section = root.querySelector<HTMLElement>('[data-use-cases]')!

    initializeUseCases(section)
    expect(
      Array.from(section.querySelectorAll<HTMLElement>('[data-code-variant="Python"]')).every(
        (variant) => !variant.hidden
      )
    ).toBe(true)

    window.dispatchEvent(new CustomEvent('lang-change', { detail: 'TypeScript' }))
    expect(
      Array.from(section.querySelectorAll<HTMLElement>('[data-code-variant="TypeScript"]')).every(
        (variant) => !variant.hidden
      )
    ).toBe(true)

    window.dispatchEvent(new CustomEvent('lang-change', { detail: 'Python' }))

    const typescriptVariants = section.querySelectorAll<HTMLElement>('[data-code-variant="TypeScript"]')
    const pythonVariants = section.querySelectorAll<HTMLElement>('[data-code-variant="Python"]')
    expect(Array.from(typescriptVariants).every((variant) => variant.hidden)).toBe(true)
    expect(Array.from(pythonVariants).every((variant) => !variant.hidden)).toBe(true)
  })

  it('copies code from the visible language variant', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const root = mount(useCaseMarkup())
    const section = root.querySelector<HTMLElement>('[data-use-cases]')!
    const activeCase = section.querySelector<HTMLElement>('[data-use-case]')!
    const copyButton = activeCase.querySelector<HTMLButtonElement>('[data-code-copy]')!
    const copyLabel = activeCase.querySelector<HTMLElement>('[data-code-copy-label]')!

    initializeUseCases(section)
    window.dispatchEvent(new CustomEvent('lang-change', { detail: 'Python' }))
    const pythonCode = activeCase.querySelector<HTMLElement>('[data-code-variant="Python"] code')?.textContent
    copyButton.click()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith(pythonCode)
    expect(copyButton.classList.contains('is-copied')).toBe(true)
    expect(copyLabel.textContent).toBe('copied!')
  })
})

describe('homepage testimonials', () => {
  it('keeps every story available until the browser is enhanced', () => {
    const root = mount(testimonialMarkup())
    const browser = root.querySelector<HTMLElement>('[data-testimonial-browser]')!
    const stories = Array.from(browser.querySelectorAll<HTMLElement>('[data-testimonial-story]'))
    const controls = browser.querySelector<HTMLElement>('[data-testimonial-controls]')!

    expect(stories.length).toBeGreaterThan(1)
    expect(stories.every((story) => !story.hasAttribute('aria-hidden'))).toBe(true)
    expect(stories.every((story) => !story.inert)).toBe(true)
    expect(controls.hidden).toBe(true)
    expect(browser.hasAttribute('aria-roledescription')).toBe(false)

    initializeTestimonialBrowsers(browser)

    expect(browser.getAttribute('aria-roledescription')).toBe('carousel')
    expect(stories[0]?.getAttribute('aria-hidden')).toBe('false')
    expect(stories[0]?.inert).toBe(false)
    expect(stories.every((story) => story.getAttribute('aria-roledescription') === 'slide')).toBe(true)
    expect(stories.slice(1).every((story) => story.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(stories.slice(1).every((story) => story.inert)).toBe(true)
    expect(controls.hidden).toBe(false)
  })

  it('rotates stories and lets the user pause rotation', async () => {
    vi.useFakeTimers()
    const root = mount(testimonialMarkup())
    const browser = root.querySelector<HTMLElement>('[data-testimonial-browser]')!
    const current = browser.querySelector<HTMLElement>('[data-testimonial-current]')!
    const toggle = browser.querySelector<HTMLButtonElement>('[data-testimonial-toggle]')!
    browser.dataset.testimonialInterval = '50'

    initializeTestimonialBrowsers(browser)
    await vi.advanceTimersByTimeAsync(50)
    expect(current.textContent).toBe('02')

    toggle.click()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    await vi.advanceTimersByTimeAsync(100)
    expect(current.textContent).toBe('02')
  })

  it('does not rotate when the user prefers reduced motion', async () => {
    vi.useFakeTimers()
    setReducedMotion(true)
    const root = mount(testimonialMarkup())
    const browser = root.querySelector<HTMLElement>('[data-testimonial-browser]')!
    const current = browser.querySelector<HTMLElement>('[data-testimonial-current]')!
    const toggle = browser.querySelector<HTMLButtonElement>('[data-testimonial-toggle]')!
    browser.dataset.testimonialInterval = '20'

    initializeTestimonialBrowsers(browser)
    await vi.advanceTimersByTimeAsync(100)

    expect(current.textContent).toBe('01')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Resume automatic story rotation')
  })
})
