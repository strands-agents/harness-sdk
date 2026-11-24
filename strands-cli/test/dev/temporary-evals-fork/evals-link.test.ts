import { describe, expect, it } from 'vitest'

import { evalsLinkText, type TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'

const host = (link: string | undefined): TemporarySessionHost =>
  ({ evalsLink: () => link }) as unknown as TemporarySessionHost

describe('evalsLinkText', () => {
  it('shouldAddTheEvalsUiAddressOnlyOnceTheUiIsReady', () => {
    expect(evalsLinkText(host(undefined), { view: 'runs' })).toBe('')
    expect(evalsLinkText(host('http://127.0.0.1:8000/runs?t=x'), { view: 'runs' })).toContain(' · evals UI ')
    expect(evalsLinkText(host('http://127.0.0.1:8000/runs?t=x'), { view: 'runs' })).toContain(
      'http://127.0.0.1:8000/runs?t=x'
    )
  })
})
