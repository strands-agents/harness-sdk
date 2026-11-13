// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { initializeBoxExamples } from '../src/util/box-examples'

function mountExamples(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <section data-box-examples>
      ${['claude-code', 'codex-cli']
        .map(
          (id, index) => `
            <article data-box-example="${id}">
              <button
                type="button"
                class="${index === 0 ? 'is-active' : ''}"
                aria-expanded="${index === 0 ? 'true' : 'false'}"
                data-box-example-button
              >
                ${id}
              </button>
              <div
                aria-hidden="${index === 0 ? 'false' : 'true'}"
                data-box-example-panel
                data-box-example-command="run ${id}"
                ${index === 0 ? '' : 'hidden'}
              >
                <button type="button" data-box-example-copy>
                  <span data-box-example-copy-label>copy</span>
                </button>
                <span data-box-example-copy-status></span>
              </div>
            </article>
          `
        )
        .join('')}
    </section>
  `
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.replaceChildren()
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Box examples', () => {
  it('switches the active example and its code panel', () => {
    const root = mountExamples()
    const section = root.querySelector<HTMLElement>('[data-box-examples]')!
    const examples = Array.from(section.querySelectorAll<HTMLElement>('[data-box-example]'))

    initializeBoxExamples(section)
    examples[1]?.querySelector<HTMLButtonElement>('[data-box-example-button]')?.click()

    expect(examples[0]?.querySelector('[data-box-example-button]')?.getAttribute('aria-expanded')).toBe('false')
    expect(examples[0]?.querySelector<HTMLElement>('[data-box-example-panel]')?.hidden).toBe(true)
    expect(examples[1]?.querySelector('[data-box-example-button]')?.getAttribute('aria-expanded')).toBe('true')
    expect(examples[1]?.querySelector<HTMLElement>('[data-box-example-panel]')?.hidden).toBe(false)
  })

  it('copies the selected example command', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const root = mountExamples()
    const section = root.querySelector<HTMLElement>('[data-box-examples]')!
    const copyButton = section.querySelector<HTMLButtonElement>('[data-box-example-copy]')!
    const copyLabel = section.querySelector<HTMLElement>('[data-box-example-copy-label]')!

    initializeBoxExamples(section)
    copyButton.click()
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('run claude-code')
    expect(copyButton.classList.contains('is-copied')).toBe(true)
    expect(copyLabel.textContent).toBe('copied!')
  })
})
