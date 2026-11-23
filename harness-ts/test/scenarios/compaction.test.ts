import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { createHarness } from '../../src/agent.js'
import { checkInvariants, record, type Recording } from './recording.js'
import { ScriptedModel } from './scripted-model.js'
import { useWorkDir } from './work-dir.js'

// Far over the size at which the context manager offloads a tool result, with a codeword in the
// middle, the part an offloaded result's preview leaves out.
const largeFile = (codeword: string): string => {
  const lines = Array.from({ length: 300 }, (_, line) => `line ${line}: quarterly budget notes.`)
  lines[150] = codeword
  return lines.join('\n')
}

const SUMMARY = 'The user asked to read report-0.txt and report-1.txt; both were read.'

/** Reads three large files over three turns, which reduces the context once, then looks back at the first. */
async function readThreeReports(dir: string): Promise<Recording> {
  const files = ['ALBATROSS', 'BERGAMOT', 'CORMORANT'].map((codeword, index) => {
    const path = join(dir, `report-${index}.txt`)
    writeFileSync(path, largeFile(codeword))
    return path
  })
  let firstReference = ''
  const model = new ScriptedModel([
    [['read', { path: files[0] }]],
    (messages: Message[]) => {
      firstReference = /\[ref: ([^\]\s]+)\]/.exec(JSON.stringify(messages.at(-1)))![1]!
      return 'read 0'
    },
    [['read', { path: files[1] }]],
    'read 1',
    [['read', { path: files[2] }]],
    { summary: true, text: SUMMARY },
    'read 2',
    () => [['retrieve_context', { reference: firstReference, pattern: 'ALBATROSS', context_lines: 0 }]],
    'retrieved',
  ])
  const agent = await createHarness({ model, memory: false, printer: false })
  const recording = record(agent)

  await agent.invoke('Read report 0.')
  // Each offloaded read adds the same number of tokens, so this window puts the summarization
  // threshold (85%) half a read past the second one, whatever the fixed overhead is.
  const [overhead, afterOneRead] = recording.calls.map((call) => call.usage!.inputTokens)
  model.updateConfig({ contextWindowLimit: Math.ceil((overhead! + 2.5 * (afterOneRead! - overhead!)) / 0.85) })
  for (const prompt of ['Read report 1.', 'Read report 2.', 'What was hidden in report 0?']) {
    await agent.invoke(prompt)
  }
  model.assertExhausted()

  checkInvariants(recording, agent, { prefixBreaks: 1, auxiliaryCalls: 1 })
  return recording
}

describe('compaction', () => {
  const workDir = useWorkDir()

  it(
    'summarizes older turns once, keeps the recent exchange verbatim and the removed content retrievable',
    { timeout: 30_000 },
    async () => {
      const recording = await readThreeReports(workDir())
      const [before, , reduced] = recording.calls.slice(4, 7)

      expect(reduced!.usage!.inputTokens).toBeLessThan(before!.usage!.inputTokens)
      expect(reduced!.messages).toEqual([
        { role: 'user', content: [{ text: 'Read report 0.' }] },
        {
          role: 'assistant',
          content: [
            { text: 'read 1' },
            {
              text: expect.stringMatching(
                new RegExp(
                  `^\\[Summarized: earlier messages, ~[\\d,]+ tokens\\]\\n\\n${SUMMARY} \\[ref: removed-[\\w-]+\\]$`
                )
              ),
              offloaded: { method: 'summarize', ref: expect.stringMatching(/^removed-/), tokens: expect.any(Number) },
            },
          ],
        },
        { role: 'user', content: [{ text: 'Read report 2.' }] },
        {
          role: 'assistant',
          content: [
            { toolUse: { name: 'read', toolUseId: 'scripted-5-0', input: { path: join(workDir(), 'report-2.txt') } } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId: 'scripted-5-0',
                status: 'success',
                content: [
                  {
                    text: expect.stringMatching(
                      /^\[Truncated: [^]+line 299: quarterly budget notes\. \[ref: scripted-5-0\]$/
                    ),
                    offloaded: { method: 'truncate', ref: 'scripted-5-0', tokens: expect.any(Number) },
                  },
                ],
              },
            },
          ],
        },
      ])

      // The middle of report 0 never reached the model, and its reference outlives the summarization.
      const requests = recording.calls.map((call) => JSON.stringify(call.messages))
      expect(requests.slice(0, -1).some((request) => request.includes('ALBATROSS'))).toBe(false)
      expect(JSON.stringify(recording.calls.at(-1)!.messages.at(-1))).toContain('ALBATROSS')
    }
  )
})
