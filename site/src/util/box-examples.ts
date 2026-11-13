import { attachCopyButton } from './clipboard'

function elementsWithin<T extends Element>(root: ParentNode, selector: string): T[] {
  const elements = Array.from(root.querySelectorAll<T>(selector))
  if (root instanceof Element && root.matches(selector)) elements.unshift(root as T)
  return elements
}

function showExample(examples: HTMLElement[], selected: HTMLElement): void {
  examples.forEach((example) => {
    const isActive = example === selected
    const button = example.querySelector<HTMLButtonElement>('[data-box-example-button]')
    const panel = example.querySelector<HTMLElement>('[data-box-example-panel]')

    button?.classList.toggle('is-active', isActive)
    button?.setAttribute('aria-expanded', isActive ? 'true' : 'false')
    if (panel) {
      panel.hidden = !isActive
      panel.setAttribute('aria-hidden', isActive ? 'false' : 'true')
    }
  })
}

export function initializeBoxExamples(root: ParentNode = document): void {
  elementsWithin<HTMLElement>(root, '[data-box-examples]').forEach((section) => {
    if (section.dataset.initialized === 'true') return

    const examples = Array.from(section.querySelectorAll<HTMLElement>('[data-box-example]'))

    examples.forEach((example) => {
      example.querySelector<HTMLButtonElement>('[data-box-example-button]')?.addEventListener('click', () => {
        showExample(examples, example)
      })

      const copyButton = example.querySelector<HTMLButtonElement>('[data-box-example-copy]')
      const panel = example.querySelector<HTMLElement>('[data-box-example-panel]')
      if (copyButton && panel) {
        attachCopyButton(copyButton, {
          label: copyButton.querySelector<HTMLElement>('[data-box-example-copy-label]'),
          status: panel.querySelector<HTMLElement>('[data-box-example-copy-status]'),
          getText: () => panel.dataset.boxExampleCommand ?? '',
          track: { surface: 'code:box-examples', detail: () => example.dataset.boxExample },
        })
      }
    })

    section.dataset.initialized = 'true'
  })
}
