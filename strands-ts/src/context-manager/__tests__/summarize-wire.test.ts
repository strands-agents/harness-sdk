import { describe, expect, it } from 'vitest'
import { TextBlock } from '../../types/messages.js'
import { WIRE_SCENARIOS, captureBaseWire, type WireCapture } from './summarize-wire-scenarios.js'
import { MAIN_BASE_WIRE } from './__fixtures__/main-base-wire-3baec37.js'

// Request bodies main (3baec37fe) sent for the same scenarios, captured on the same fail-closed wire; the branch
// must send the same bytes.
const MAIN: Record<string, WireCapture> = MAIN_BASE_WIRE

interface WireMessage {
  role: string
  content: { type: string; text?: string }[]
}

function summaryText(conversation: string): string | undefined {
  const request = JSON.parse(conversation) as { messages: WireMessage[] }
  const blocks = request.messages.flatMap((message) => message.content)
  return blocks.find((block) => block.text?.startsWith('[Summarized:'))?.text
}

describe('base summary wire against main', () => {
  it.each(WIRE_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))('%s', async (name, scenario) => {
    const main = MAIN[name]!
    const branch = await captureBaseWire(scenario)

    expect(branch.summarizer).toBe(main.summarizer)
    expect(summaryText(branch.conversation)).toBe(summaryText(main.conversation))
    expect(summaryText(branch.conversation)).toMatch(/^\[Summarized: \d+ messages, ~\d+ tokens\]\n\n/)
    expect(branch.conversation).toBe(main.conversation)
  })

  it('stores the summary as its own message, without the header', async () => {
    const { stored } = await captureBaseWire(WIRE_SCENARIOS[1]!)
    expect(stored!.map((message) => message.role)).toStrictEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant',
    ])
    expect(stored![1]!.content).toStrictEqual([
      new TextBlock('SUMMARY OF EARLIER TURNS', {
        metadata: { offloaded: { method: 'summarize', removedMessages: 2, removedTokens: 60 } },
      }),
    ])
  })
})
