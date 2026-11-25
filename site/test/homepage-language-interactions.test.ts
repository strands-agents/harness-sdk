import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LANGUAGE_STORAGE_KEY } from '../src/util/language-preference'

const homepageHtml = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8')
const sourceDocument = new JSDOM(homepageHtml).window.document
let moduleImportId = 0

function inlineScript(marker: string): string {
  const script =
    [...sourceDocument.querySelectorAll<HTMLScriptElement>('script:not([src])')].find((candidate) =>
      candidate.textContent.includes(marker)
    )?.textContent ?? ''
  if (!script) throw new Error(`Missing inline script containing ${marker}`)
  return script
}

function moduleScript(component: string): URL {
  const src = [...sourceDocument.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .find((script) => script.getAttribute('src')?.includes(component))
    ?.getAttribute('src')
  if (!src) throw new Error(`Missing module script for ${component}`)
  return new URL(`../dist/${src.replace(/^\//, '')}`, import.meta.url)
}

async function importModule(component: string): Promise<void> {
  const url = moduleScript(component)
  await import(/* @vite-ignore */ `${url.href}?homepage-language-test=${moduleImportId++}`)
}

function loadHomepage(preference = 'TypeScript') {
  const dom = new JSDOM(homepageHtml, {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://example.test/',
  })
  const { window } = dom
  const matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
  }))

  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia })

  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('localStorage', window.localStorage)
  vi.stubGlobal('navigator', window.navigator)
  vi.stubGlobal('CustomEvent', window.CustomEvent)
  vi.stubGlobal('matchMedia', matchMedia)

  return window
}

function changeLanguage(window: JSDOM['window'], language: string): void {
  window.dispatchEvent(new window.CustomEvent('lang-change', { detail: language }))
}

function visibleInstallVariant(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>('[data-install-variant]:not([aria-hidden="true"])')
}

function visibleToolkitPanel(terminal: HTMLElement): HTMLElement | null {
  return terminal.querySelector<HTMLElement>('[data-lang-code]:not([hidden])')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('homepage language interactions', () => {
  it('initializes install commands that render later in the document', () => {
    const sourceBlock = sourceDocument.querySelector<HTMLElement>('[data-install]')
    if (!sourceBlock) throw new Error('Missing install command fixture')

    const dom = new JSDOM(sourceBlock.outerHTML, {
      runScripts: 'outside-only',
      url: 'https://example.test/',
    })
    const { window } = dom
    const script = inlineScript('data-install-unavailable')

    window.eval(script)
    const laterBlock = sourceBlock.cloneNode(true) as HTMLElement
    window.document.body.append(laterBlock)
    window.eval(script)
    changeLanguage(window, 'Rust')

    expect(visibleInstallVariant(laterBlock)).toBeNull()
    expect(laterBlock.querySelector<HTMLElement>('[data-install-unavailable]')?.textContent).toBe(
      'No Rust install command is available yet.'
    )
  })

  it('never substitutes TypeScript for an unavailable language', async () => {
    const window = loadHomepage()

    window.eval(inlineScript('__strandsLanguageToggleInit'))
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'))
    window.eval(inlineScript('data-install-unavailable'))
    await importModule('ToolkitTerminal.astro')
    await importModule('UseCases.astro')
    await importModule('Footer.astro')

    const installBlocks = [...window.document.querySelectorAll<HTMLElement>('[data-install]')]
    const harnessTerminal = window.document
      .querySelector<HTMLButtonElement>('[data-toolkit-terminal-copy][aria-label="Copy Strands harness example"]')
      ?.closest<HTMLElement>('[data-toolkit-terminal]')
    const evalsTerminal = window.document
      .querySelector<HTMLButtonElement>('[data-toolkit-terminal-copy][aria-label="Copy /evals code"]')
      ?.closest<HTMLElement>('[data-toolkit-terminal]')
    const genericTerminals = [...window.document.querySelectorAll<HTMLElement>('[data-toolkit-terminal]')].filter(
      (terminal) =>
        terminal.querySelector('[data-lang-code="policy"], [data-lang-code="shell"], [data-lang-code="toml"]')
    )
    const useCases = window.document.querySelector<HTMLElement>('.use-cases')
    const useCasesUnavailable = useCases?.querySelector<HTMLElement>('[data-use-cases-unavailable]')
    const useCasesCopy = useCases?.querySelector<HTMLButtonElement>('.terminal__copy')
    const filename = useCases?.querySelector<HTMLElement>('[data-filename]')
    const footerOptions = [...window.document.querySelectorAll<HTMLButtonElement>('[data-footer-lang] [data-lang]')]
    const languageToggles = [...window.document.querySelectorAll<HTMLElement>('language-toggle')]

    expect(installBlocks.length).toBeGreaterThan(0)
    expect(harnessTerminal).not.toBeNull()
    expect(evalsTerminal).not.toBeNull()
    expect(genericTerminals.length).toBeGreaterThan(0)
    expect(languageToggles.length).toBeGreaterThan(0)
    expect(window.document.documentElement.dataset.langPref).toBe('typescript')
    expect(installBlocks.every((block) => visibleInstallVariant(block)?.dataset.installVariant === 'TypeScript')).toBe(
      true
    )
    expect(visibleToolkitPanel(harnessTerminal!)?.dataset.langCode).toBe('typescript')
    expect(visibleToolkitPanel(evalsTerminal!)).toBeNull()
    expect(evalsTerminal?.querySelector<HTMLElement>('[data-toolkit-terminal-unavailable]')?.textContent).toBe(
      'No TypeScript example is available yet.'
    )
    expect(filename?.textContent).toBe('lead_router.ts')
    expect(footerOptions.find((option) => option.dataset.lang === 'TypeScript')?.getAttribute('aria-pressed')).toBe(
      'true'
    )

    changeLanguage(window, 'Rust')

    expect(window.document.documentElement.dataset.langPref).toBe('rust')
    for (const block of installBlocks) {
      expect(visibleInstallVariant(block)).toBeNull()
      expect(block.querySelector<HTMLElement>('[data-install-unavailable]')?.textContent).toBe(
        'No Rust install command is available yet.'
      )
      expect(block.querySelector<HTMLButtonElement>('[data-install-copy]')?.disabled).toBe(true)
    }
    for (const terminal of [harnessTerminal!, evalsTerminal!]) {
      expect(visibleToolkitPanel(terminal)).toBeNull()
      expect(terminal.querySelector<HTMLElement>('[data-toolkit-terminal-unavailable]')?.textContent).toBe(
        'No Rust example is available yet.'
      )
      expect(terminal.querySelector<HTMLButtonElement>('[data-toolkit-terminal-copy]')?.disabled).toBe(true)
    }
    for (const terminal of genericTerminals) {
      expect(visibleToolkitPanel(terminal)).not.toBeNull()
      expect(terminal.querySelector<HTMLElement>('[data-toolkit-terminal-unavailable]')?.hidden).toBe(true)
      expect(terminal.querySelector<HTMLButtonElement>('[data-toolkit-terminal-copy]')?.disabled).toBe(false)
    }
    expect(useCases?.querySelector('.terminal__code:not([hidden])')).toBeNull()
    expect(useCasesUnavailable?.textContent).toBe('No Rust example is available yet.')
    expect(useCasesUnavailable?.hidden).toBe(false)
    expect(useCasesCopy?.disabled).toBe(true)
    expect(filename?.textContent).toBe('No Rust example')
    expect(footerOptions.every((option) => option.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(
      languageToggles.every(
        (toggle) => toggle.getAttribute('aria-label') === 'Preferred language: Rust (not available in this selector)'
      )
    ).toBe(true)
    expect(
      languageToggles.every((toggle) =>
        [...toggle.querySelectorAll<HTMLButtonElement>('.lang-option:not(:disabled)')].every(
          (option) => option.getAttribute('aria-checked') === 'false' && option.tabIndex === 0
        )
      )
    ).toBe(true)

    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'Python')
    window.dispatchEvent(
      new window.StorageEvent('storage', {
        key: LANGUAGE_STORAGE_KEY,
        newValue: 'Python',
      })
    )

    expect(window.document.documentElement.dataset.langPref).toBe('python')
    expect(installBlocks.every((block) => visibleInstallVariant(block)?.dataset.installVariant === 'Python')).toBe(true)
    expect(
      installBlocks.every((block) => !block.querySelector<HTMLButtonElement>('[data-install-copy]')?.disabled)
    ).toBe(true)
    expect(visibleToolkitPanel(harnessTerminal!)?.dataset.langCode).toBe('python')
    expect(visibleToolkitPanel(evalsTerminal!)?.dataset.langCode).toBe('python')
    expect(useCases?.querySelector<HTMLElement>('.terminal__code:not([hidden])')?.dataset.langCode).toBe('python')
    expect(useCasesUnavailable?.hidden).toBe(true)
    expect(useCasesCopy?.disabled).toBe(false)
    expect(filename?.textContent).toBe('lead_router.py')
    expect(footerOptions.find((option) => option.dataset.lang === 'Python')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('resolves an unavailable preference when every toggle offers one language', () => {
    const window = loadHomepage('Rust')
    const typeScriptOptions = [
      ...window.document.querySelectorAll<HTMLButtonElement>('language-toggle [data-lang="TypeScript"]'),
    ]

    expect(typeScriptOptions.length).toBeGreaterThan(1)
    for (const option of typeScriptOptions) option.disabled = true

    window.eval(inlineScript('__strandsLanguageToggleInit'))
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'))

    const pythonOptions = [
      ...window.document.querySelectorAll<HTMLButtonElement>('language-toggle [data-lang="Python"]'),
    ]
    expect(window.document.documentElement.dataset.langPref).toBe('python')
    expect(pythonOptions.every((option) => option.getAttribute('aria-checked') === 'true')).toBe(true)
  })
})
