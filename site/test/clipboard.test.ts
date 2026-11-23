// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachCopyButton, COPY_EVENT } from '../src/util/clipboard'

const copyListeners: EventListener[] = []

function listenForCopy(listener: EventListener) {
  copyListeners.push(listener)
  window.addEventListener(COPY_EVENT, listener)
}

function buildButton() {
  const button = document.createElement('button')
  const label = document.createElement('span')
  button.setAttribute('aria-label', 'Copy the visible command')
  label.textContent = 'copy'
  button.append(label)
  document.body.append(button)
  return { button, label }
}

async function settleClipboardPromise() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  document.body.replaceChildren()
  copyListeners.forEach((listener) => window.removeEventListener(COPY_EVENT, listener))
  copyListeners.length = 0
})

describe('attachCopyButton', () => {
  it('announces copy success and restores the original accessible label', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { button, label } = buildButton()

    attachCopyButton(button, {
      getText: () => 'box --version',
      label,
      resetMs: 100,
    })
    button.click()
    await settleClipboardPromise()

    expect(writeText).toHaveBeenCalledWith('box --version')
    expect(label.textContent).toBe('copied!')
    expect(button.getAttribute('aria-label')).toBe('Copied to clipboard')

    vi.advanceTimersByTime(100)

    expect(label.textContent).toBe('copy')
    expect(button.getAttribute('aria-label')).toBe('Copy the visible command')
  })

  it('announces copy failure and restores the original accessible label', async () => {
    vi.useFakeTimers()
    const failure = new Error('clipboard unavailable')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(failure) },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { button, label } = buildButton()

    attachCopyButton(button, {
      getText: () => 'box --version',
      label,
      resetMs: 100,
    })
    button.click()
    await settleClipboardPromise()

    expect(label.textContent).toBe('failed')
    expect(button.getAttribute('aria-label')).toBe('Copy to clipboard failed')

    vi.advanceTimersByTime(100)

    expect(label.textContent).toBe('copy')
    expect(button.getAttribute('aria-label')).toBe('Copy the visible command')
  })

  it('resets pending feedback before an asynchronous copy finishes', async () => {
    let resolveCopy: (() => void) | undefined
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveCopy = resolve
            })
        ),
      },
    })
    const { button, label } = buildButton()
    const copyEvent = vi.fn()
    listenForCopy(copyEvent)

    const controller = attachCopyButton(button, {
      getText: () => 'box run claude',
      label,
      track: { surface: 'command:box-agent', detail: () => 'claude-code' },
    })
    button.click()
    controller.reset()
    resolveCopy?.()
    await settleClipboardPromise()

    expect(label.textContent).toBe('copy')
    expect(button.getAttribute('aria-label')).toBe('Copy the visible command')
    expect(copyEvent).not.toHaveBeenCalled()
  })

  it('captures analytics detail when the copy starts', async () => {
    let resolveCopy: (() => void) | undefined
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveCopy = resolve
            })
        ),
      },
    })
    const { button, label } = buildButton()
    let detail = 'claude-code'
    const copyEvent = vi.fn()
    listenForCopy(copyEvent)

    attachCopyButton(button, {
      getText: () => 'box run claude',
      label,
      track: { surface: 'command:box-agent', detail: () => detail },
    })
    button.click()
    detail = 'codex'
    resolveCopy?.()
    await settleClipboardPromise()

    expect(copyEvent).toHaveBeenCalledOnce()
    expect(copyEvent.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        label: 'command:box-agent:claude-code',
        text: 'box run claude',
      },
    })
  })
})
