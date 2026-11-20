import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../src/components/Analytics.astro', import.meta.url), 'utf8')
const script = source.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error('Analytics inline script not found')

// Regression for the consent review on #4446: copied text must not reach the WebSDK without performance consent.
describe('custom analytics consent', () => {
  let dom: JSDOM
  const getConsentCookie = vi.fn<() => unknown>()
  const received = vi.fn()

  beforeEach(() => {
    getConsentCookie.mockReset()
    received.mockReset()
    dom = new JSDOM('<div class="copy"><button data-code="pip install strands-harness">Copy</button></div>', {
      url: 'https://strandsagents.com/docs/user-guide/harness/quickstart/',
      runScripts: 'outside-only',
    })
    dom.window.strandsShortbread = { getConsentCookie }
    dom.window.addEventListener('custom-awsm-acs-event-listener', (event) => {
      received((event as CustomEvent).detail)
    })
    dom.window.eval(script)
  })

  afterEach(() => {
    dom.window.close()
  })

  function copyFromHelper() {
    dom.window.dispatchEvent(
      new dom.window.CustomEvent('strands:copy', {
        detail: { label: 'install:pip', text: 'pip install strands-harness' },
      })
    )
  }

  function copyFromCodeBlock() {
    dom.window.document.querySelector<HTMLButtonElement>('button')!.click()
  }

  for (const [name, copy] of [
    ['shared clipboard helper', copyFromHelper],
    ['code block button', copyFromCodeBlock],
  ] as const) {
    describe(name, () => {
      it.each([
        ['missing preferences', undefined],
        ['empty preferences', {}],
        ['declined optional cookies', { performance: false, functional: false }],
        ['functional consent only', { performance: false, functional: true }],
        ['a truthy non-boolean preference', { performance: 'true', functional: true }],
      ])('drops copied text with %s', (_name, consent) => {
        getConsentCookie.mockReturnValue(consent)
        copy()
        expect(received).not.toHaveBeenCalled()
      })

      it('dispatches the copied-text label with performance consent', () => {
        getConsentCookie.mockReturnValue({ performance: true, functional: true })
        copy()
        expect(received).toHaveBeenCalledExactlyOnceWith({
          eventType: 'web.awsm.customCTAClick',
          xdm: {
            _aws: {
              pageInteraction: {
                click: {
                  name:
                    name === 'shared clipboard helper'
                      ? 'code-copy:install:pip | pip install strands-harness'
                      : 'code-copy:user-guide|harness|quickstart | pip install strands-harness',
                  type: 'customClick',
                },
              },
            },
          },
          useBeacon: false,
        })
      })
    })
  }

  it('drops events when Shortbread is unavailable', () => {
    delete dom.window.strandsShortbread
    copyFromHelper()
    expect(received).not.toHaveBeenCalled()
  })

  it('drops events when the consent lookup fails', () => {
    getConsentCookie.mockImplementation(() => {
      throw new Error('Consent unavailable')
    })
    copyFromHelper()
    expect(received).not.toHaveBeenCalled()
  })

  it('uses current consent without replaying previously dropped copy events', () => {
    getConsentCookie.mockReturnValue({ performance: false, functional: true })
    copyFromHelper()

    getConsentCookie.mockReturnValue({ performance: true, functional: true })
    dom.window.dispatchEvent(new dom.window.Event('cookie-consent-changed'))
    expect(received).not.toHaveBeenCalled()

    copyFromHelper()
    expect(received).toHaveBeenCalledTimes(1)

    getConsentCookie.mockReturnValue({ performance: false, functional: true })
    copyFromHelper()
    expect(received).toHaveBeenCalledTimes(1)
  })

  it('also gates other custom events, including the unload beacon path', () => {
    getConsentCookie.mockReturnValue({ performance: false, functional: true })
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'))
    expect(received).not.toHaveBeenCalled()
  })
})
