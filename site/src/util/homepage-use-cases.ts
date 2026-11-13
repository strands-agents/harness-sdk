import { attachCopyButton } from './clipboard'
import { DEFAULT_LANGUAGE_LABEL, LANGUAGE_STORAGE_KEY } from './language-preference'

type Language = 'TypeScript' | 'Python'

function elementsWithin<T extends Element>(root: ParentNode, selector: string): T[] {
  const elements = Array.from(root.querySelectorAll<T>(selector))
  if (root instanceof Element && root.matches(selector)) elements.unshift(root as T)
  return elements
}

function rootWindow(root: ParentNode): Window & typeof globalThis {
  const document = root instanceof Document ? root : root.ownerDocument
  return (document?.defaultView ?? window) as Window & typeof globalThis
}

function storedLanguage(root: ParentNode): Language {
  try {
    return rootWindow(root).localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'Python' ? 'Python' : DEFAULT_LANGUAGE_LABEL
  } catch {
    return DEFAULT_LANGUAGE_LABEL
  }
}

function showUseCase(cases: HTMLElement[], selected: HTMLElement): void {
  cases.forEach((useCase) => {
    const isActive = useCase === selected
    const button = useCase.querySelector<HTMLButtonElement>('[data-use-case-button]')
    const panel = useCase.querySelector<HTMLElement>('[data-use-case-panel]')

    button?.classList.toggle('is-active', isActive)
    button?.setAttribute('aria-expanded', isActive ? 'true' : 'false')
    if (panel) {
      panel.hidden = !isActive
      panel.setAttribute('aria-hidden', isActive ? 'false' : 'true')
    }
  })
}

function showLanguage(section: HTMLElement, language: Language): void {
  section.querySelectorAll<HTMLElement>('[data-code-variant]').forEach((variant) => {
    variant.hidden = variant.dataset.codeVariant !== language
  })
  section.querySelectorAll<HTMLElement>('[data-code-filename]').forEach((filename) => {
    filename.hidden = filename.dataset.codeFilename !== language
  })
}

export function initializeUseCases(root: ParentNode = document): void {
  elementsWithin<HTMLElement>(root, '[data-use-cases]').forEach((section) => {
    if (section.dataset.initialized === 'true') return

    const cases = Array.from(section.querySelectorAll<HTMLElement>('[data-use-case]'))
    const languageWindow = rootWindow(section)
    const languageDocument = section.ownerDocument
    const abortController = new AbortController()
    let language = storedLanguage(section)

    cases.forEach((useCase) => {
      useCase.querySelector<HTMLButtonElement>('[data-use-case-button]')?.addEventListener('click', () => {
        showUseCase(cases, useCase)
      })

      const copyButton = useCase.querySelector<HTMLButtonElement>('[data-code-copy]')
      if (copyButton) {
        attachCopyButton(copyButton, {
          label: copyButton.querySelector<HTMLElement>('[data-code-copy-label]'),
          getText: () =>
            useCase.querySelector<HTMLElement>('[data-code-variant]:not([hidden]) code')?.textContent ?? '',
          track: { surface: 'code:use-cases', detail: () => language },
        })
      }
    })

    languageWindow.addEventListener(
      'lang-change',
      (event: Event) => {
        language = (event as CustomEvent).detail === 'Python' ? 'Python' : 'TypeScript'
        showLanguage(section, language)
      },
      { signal: abortController.signal }
    )
    languageDocument.addEventListener(
      'astro:before-swap',
      () => {
        abortController.abort()
      },
      { once: true, signal: abortController.signal }
    )

    showLanguage(section, language)
    section.dataset.initialized = 'true'
  })
}
