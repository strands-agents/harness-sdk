import { attachCopyButton } from './clipboard'
import { DEFAULT_LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY } from './language-preference'

const initializedLanguageRoots = new WeakSet<ParentNode>()

function elementsWithin<T extends Element>(root: ParentNode, selector: string): T[] {
  const elements = Array.from(root.querySelectorAll<T>(selector))
  if (root instanceof Element && root.matches(selector)) elements.unshift(root as T)
  return elements
}

function normalizedLanguage(language: string | null | undefined): string {
  return language === 'Python' ? 'Python' : DEFAULT_LANGUAGE_LABEL
}

function rootWindow(root: ParentNode): Window {
  const document = root instanceof Document ? root : root.ownerDocument
  return document?.defaultView ?? window
}

export function setHomepageCodeExampleOpen(example: HTMLElement, willOpen: boolean): void {
  example.classList.toggle('is-open', willOpen)
  example.closest<HTMLElement>('[data-example-container]')?.classList.toggle('is-open', willOpen)

  const toggle = example.querySelector<HTMLButtonElement>('[data-example-toggle]')
  const panel = example.querySelector<HTMLElement>('[data-example-panel]')
  const label = toggle?.querySelector<HTMLElement>('[data-example-toggle-label]')
  const productName = example.dataset.productName ?? 'this product'

  toggle?.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
  toggle?.setAttribute('aria-label', `${willOpen ? 'Hide' : 'View'} code example for ${productName}`)
  if (panel) panel.hidden = !willOpen
  if (label) label.textContent = willOpen ? 'Hide code' : (example.dataset.exampleClosedLabel ?? 'View code')
}

export function applyHomepageCodeLanguage(root: ParentNode, language: string): void {
  const activeLanguage = normalizedLanguage(language)

  elementsWithin<HTMLElement>(root, '[data-code-language-sync]').forEach((example) => {
    example.querySelectorAll<HTMLElement>('[data-example-language]').forEach((pane) => {
      pane.hidden = pane.dataset.exampleLanguage !== activeLanguage
    })
    const label = example.querySelector<HTMLElement>('[data-terminal-language]')
    if (label) label.textContent = activeLanguage
  })
}

function storedLanguage(root: ParentNode): string {
  try {
    return normalizedLanguage(rootWindow(root).localStorage.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return DEFAULT_LANGUAGE_LABEL
  }
}

function initializeDisclosure(root: ParentNode, example: HTMLElement): void {
  if (example.dataset.exampleInitialized === 'true') return
  example.dataset.exampleInitialized = 'true'

  example.querySelector<HTMLButtonElement>('[data-example-toggle]')?.addEventListener('click', () => {
    const willOpen = !example.classList.contains('is-open')
    const group = example.dataset.exampleGroup

    if (willOpen && group) {
      elementsWithin<HTMLElement>(root, '[data-example-card].is-open').forEach((openExample) => {
        if (openExample !== example && openExample.dataset.exampleGroup === group) {
          setHomepageCodeExampleOpen(openExample, false)
        }
      })
    }

    setHomepageCodeExampleOpen(example, willOpen)
  })
}

function initializeCopyButton(terminal: HTMLElement): void {
  const button = terminal.querySelector<HTMLButtonElement>('[data-code-copy]')
  if (!button || button.dataset.copyInitialized === 'true') return
  button.dataset.copyInitialized = 'true'

  attachCopyButton(button, {
    label: button.querySelector<HTMLElement>('[data-code-copy-label]'),
    getText: () => terminal.querySelector<HTMLElement>('[data-code-value]:not([hidden])')?.dataset.codeValue ?? '',
    track: {
      surface: 'code:homepage',
      detail: () => terminal.querySelector<HTMLElement>('[data-terminal-language]')?.textContent?.trim(),
    },
  })
}

export function initHomepageCodeExamples(root: ParentNode = document): void {
  elementsWithin<HTMLElement>(root, '[data-example-card]').forEach((example) => {
    initializeDisclosure(root, example)
  })
  elementsWithin<HTMLElement>(root, '[data-code-terminal]').forEach(initializeCopyButton)

  const languageExamples = elementsWithin<HTMLElement>(root, '[data-code-language-sync]')
  if (languageExamples.length === 0 || initializedLanguageRoots.has(root)) return

  initializedLanguageRoots.add(root)
  applyHomepageCodeLanguage(root, storedLanguage(root))
  rootWindow(root).addEventListener('lang-change', (event: Event) => {
    applyHomepageCodeLanguage(root, (event as CustomEvent<string>).detail)
  })
}
