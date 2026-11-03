/**
 * Live: summarization on preserved-thinking Claude models over first-party Anthropic.
 *
 * Needs ANTHROPIC_API_KEY, and runs only in GitHub Actions or with STRANDS_INTEG_NATIVE_COMPACTION=1, because the
 * integ setup also loads keys from AWS Secrets Manager and a local aggregate run must not start paid requests.
 * Bounded: one task of 7 tool turns and 2 forced summary passes per run, two runs.
 */

import { describe, expect, it } from 'vitest'
import { inject } from 'vitest'
import {
  EXPECTED_SUM,
  CODEWORD,
  HAIKU_5_5,
  SONNET_5_5,
  STRICT_THINKING,
  describeReport,
  runCompactionTask,
  type Exchange,
} from './native-compaction-harness.js'

const optedIn = process.env.GITHUB_ACTIONS === 'true' || process.env.STRANDS_INTEG_NATIVE_COMPACTION === '1'
const apiKey = (): string => inject('provider-anthropic').apiKey!
const skip = !optedIn || inject('provider-anthropic').shouldSkip
const mainModelId = process.env.STRANDS_INTEG_MAIN_MODEL_ID ?? SONNET_5_5
const summarizerModelId = process.env.STRANDS_INTEG_SUMMARIZER_MODEL_ID ?? HAIKU_5_5
const PASSES = [4, 7]

const ofKind = (exchanges: Exchange[], kind: Exchange['kind']): Exchange[] =>
  exchanges.filter((exchange) => exchange.kind === kind)

describe.skipIf(skip)('native compaction on preserved-thinking models (live)', () => {
  it('compacts on every pass, replays each block first and unchanged, and keeps the tail thinking', async () => {
    const report = await runCompactionTask({
      apiKey: apiKey(),
      mainModelId,
      summarizerModelId,
      serverSideCompaction: true,
      thinking: STRICT_THINKING,
      passBeforeCalls: PASSES,
    })
    console.log(`native run | ${describeReport(report)}`)

    // Every request succeeded on its first attempt: no 400, no reactive drop_block retry.
    expect(report.exchanges.map((exchange) => exchange.status).filter((status) => status !== 200)).toStrictEqual([])
    expect(report.dropBlockWarnings).toStrictEqual([])

    // Every pass called native compaction, and none fell back to a client-side summary.
    const compactions = ofKind(report.exchanges, 'compaction')
    expect(report.passes).toBe(PASSES.length)
    expect(compactions).toHaveLength(PASSES.length)
    expect(ofKind(report.exchanges, 'summarizer')).toHaveLength(0)
    expect(compactions.every((exchange) => exchange.model === summarizerModelId)).toBe(true)

    // Each returned block is replayed exactly as returned on every later request, as the only compaction block.
    const conversations = ofKind(report.exchanges, 'conversation')
    for (const compaction of compactions) {
      expect(compaction.returned).toHaveLength(1)
      const block = compaction.returned[0]!
      const later = conversations.filter((exchange) =>
        exchange.sentCompaction.some((sent) => sent.signature === block.signature)
      )
      expect(later.length).toBeGreaterThan(0)
      for (const exchange of later) expect(exchange.sentCompaction).toStrictEqual([block])
    }

    // Kept thinking is in the outgoing tail after each pass, and the API dropped no thinking block.
    const returnedThinking = new Set(conversations.flatMap((exchange) => exchange.returnedThinking))
    for (const compaction of compactions) {
      const next =
        conversations[
          conversations.findIndex(
            (exchange) => exchange.sentCompaction[0]?.signature === compaction.returned[0]!.signature
          )
        ]!
      expect(next.sentThinking.length).toBeGreaterThan(0)
      expect(next.sentThinking.every((signature) => returnedThinking.has(signature))).toBe(true)
    }
    const mainTransformations = conversations.flatMap((exchange) => exchange.inputTransformations ?? [])
    expect(mainTransformations).toStrictEqual([])
    // Observability: the field must have been seen on main-model responses, or the absence above proves nothing.
    expect(conversations.some((exchange) => exchange.inputTransformations !== undefined)).toBe(true)

    // The task survived the replacement of message 0 and finished.
    expect(report.messageZeroAfter).toBe('textBlock')
    for (const codewords of report.codewordsAfterPass) {
      expect(codewords.length).toBeGreaterThan(0)
      expect(codewords.every((codeword) => codeword === CODEWORD)).toBe(true)
    }
    expect(report.finalText).toContain(`DONE ${EXPECTED_SUM}`)
    expect(report.usage.totalTokens).toBeGreaterThan(0)
  })

  it('takes the client-side path when the capability is unset (control)', async () => {
    const report = await runCompactionTask({
      apiKey: apiKey(),
      mainModelId,
      summarizerModelId,
      serverSideCompaction: undefined,
      thinking: { type: 'adaptive' },
      passBeforeCalls: PASSES,
    })
    console.log(`base control | ${describeReport(report)}`)

    expect(ofKind(report.exchanges, 'compaction')).toHaveLength(0)
    expect(ofKind(report.exchanges, 'summarizer')).toHaveLength(PASSES.length)
    expect(report.exchanges.every((exchange) => exchange.sentCompaction.length === 0)).toBe(true)
    expect(report.finalText).toContain(`DONE ${EXPECTED_SUM}`)
  })
})
