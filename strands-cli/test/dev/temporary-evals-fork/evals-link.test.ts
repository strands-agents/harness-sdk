import { describe, expect, it } from 'vitest'

import { evalsLinkText, type TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import { sanitizeTerminalText } from '../../../src/terminal/text.js'

const host = (link: string | undefined): TemporarySessionHost =>
  ({ evalsLink: () => link }) as unknown as TemporarySessionHost

describe('evalsLinkText', () => {
  it('shouldAddTheEvalsUiAddressOnlyOnceTheUiIsReady', () => {
    expect(evalsLinkText(host(undefined), { view: 'runs' })).toBe('')
    expect(evalsLinkText(host('http://127.0.0.1:8000/experiments?t=x'), { view: 'runs' })).toBe(
      '\nevals UI: http://127.0.0.1:8000/experiments?t=x'
    )
  })

  it('shouldKeepTheTokenInTheLinkAfterTheChatCleansTheNotice', () => {
    const text = `experiment · refunds · 5 cases saved${evalsLinkText(host('http://127.0.0.1:8000/experiments?t=x'), { view: 'runs' })}`

    expect(sanitizeTerminalText(text)).toContain('http://127.0.0.1:8000/experiments?t=x')
  })
})
