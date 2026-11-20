import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, type Usage } from '@strands-agents/sdk'
import { describe, expect, it, onTestFailed } from 'vitest'
import { z } from 'zod'

import { checkInvariants, prefixBreaks, record } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

// Large enough that the context manager offloads each result to a fixed-size preview.
const fetchReport = tool({
  name: 'fetch_report',
  description: 'Fetches one part of the quarterly report.',
  inputSchema: z.object({ part: z.number() }),
  callback: ({ part }) =>
    Array.from(
      { length: 250 },
      (_, row) => `Report ${part}, row ${row}: revenue ${part * 1000 + row} and costs ${(row % 9) + 40}, both flat.`
    ).join('\n'),
})

const promptTokens = (usage: Usage): number =>
  usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)

describe('compaction', () => {
  useWorkDir()

  it('summarizes mid-conversation, keeps the provider accepting requests and still recalls the codeword', async () => {
    const agent = await buildAgent({ tools: [fetchReport] })
    const recording = record(agent)
    onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', 'compaction.json')))

    await agent.invoke(
      `${TESTING} Remember this codeword for later: OCELOT-93. Then call fetch_report with part 1 and reply "ok".`
    )
    // Sized from the first turn's real usage so that the third report crosses the summarization
    // threshold (85% of the window) by half a report, whatever the model's tokenizer.
    const firstTurn = recording.loopCalls.map((call) => promptTokens(call.usage!))
    const report = firstTurn.at(-1)! - firstTurn[0]!
    agent.model.updateConfig({ contextWindowLimit: Math.ceil((firstTurn[0]! + 2.5 * report) / 0.85) })

    await agent.invoke(`${TESTING} Call fetch_report with part 2 and reply "ok".`)
    await agent.invoke(`${TESTING} Call fetch_report with part 3 and reply "ok".`)
    const result = await agent.invoke(`${TESTING} Reply with the codeword I asked you to remember.`)

    checkInvariants(recording, agent, { prefixBreaks: 1, auxiliaryCalls: 1 })
    const [reduced] = prefixBreaks(recording)
    expect(JSON.stringify(recording.calls[reduced!]!.messages)).toContain('[Summarized: ')
    expect(result.toString()).toContain('OCELOT-93')
  })
})
