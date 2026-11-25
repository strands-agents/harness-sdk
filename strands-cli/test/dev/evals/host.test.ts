import { describe, expect, it } from 'vitest'

import {
  evalsLinkText,
  evalsFileChangeWarning,
  type EvalsAgentFacts,
  type EvalsSessionHost,
} from '../../../src/dev/evals/host.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { sanitizeTerminalText } from '../../../src/terminal/text.js'

const linked = (link: string | undefined): EvalsSessionHost =>
  ({ evalsLink: () => link }) as unknown as EvalsSessionHost

const withTools = (tools: readonly string[]): EvalsSessionHost => ({
  workspace: { root: '/w/project' } as DevWorkspace,
  agent: (): EvalsAgentFacts => ({ tools: tools.map((name) => ({ name, description: '' })) }),
})

describe('evalsLinkText', () => {
  it('shouldAddTheEvalsUiAddressOnlyOnceTheUiIsReady', () => {
    expect(evalsLinkText(linked(undefined), { view: 'runs' })).toBe('')
    expect(evalsLinkText(linked('http://127.0.0.1:8000/experiments?t=x'), { view: 'runs' })).toBe(
      '\nevals UI: http://127.0.0.1:8000/experiments?t=x'
    )
  })

  it('shouldKeepTheTokenInTheLinkAfterTheChatCleansTheNotice', () => {
    const text = `experiment · refunds · 5 cases saved${evalsLinkText(linked('http://127.0.0.1:8000/experiments?t=x'), { view: 'runs' })}`

    expect(sanitizeTerminalText(text)).toContain('http://127.0.0.1:8000/experiments?t=x')
  })
})

describe('evalsFileChangeWarning', () => {
  it.each([
    [
      ['shell', 'read', 'write', 'edit', 'strands_dev_status'],
      'its shell, write, and edit tools can change files there.',
    ],
    [['edit', 'edit'], 'its edit tool can change files there.'],
  ])('shouldNameTheToolsThatCanChangeFilesWhenTheAgentHas %j', (tools, ending) => {
    expect(evalsFileChangeWarning(withTools(tools))).toBe(
      `Evaluations and optimizations run this agent in /w/project, and ${ending}`
    )
  })

  it.each([[[]], [['read', 'web_search', 'web_fetch']]])('shouldGiveNoWarningWhenTheAgentHas %j', (tools) => {
    expect(evalsFileChangeWarning(withTools(tools))).toBeUndefined()
  })
})
