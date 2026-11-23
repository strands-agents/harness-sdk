import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Agent, BedrockModel, tool, type Usage } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { describe, expect, it, onTestFailed } from 'vitest'
import { z } from 'zod'

import { checkInvariants, record } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

// Pushes the cacheable prefix (system prompt and tool specs) over every model's minimum cacheable size.
// The rules differ from one another because some models refuse a prompt of repeated filler.
const STABLE_PREFIX = Array.from(
  { length: 250 },
  (_, rule) =>
    `Protocol rule ${rule}: when a request mentions topic ${rule}, answer in at most ${(rule % 7) + 2} sentences ` +
    `and cite section ${rule * 3}.`
).join('\n')

// Each page is about 1,200 tokens, so the conversation soon outweighs the fixed prefix: a request
// can only re-read most of the previous one if the messages are cached too.
const fetchPage = tool({
  name: 'fetch_page',
  description: 'Fetches one page of the manual.',
  inputSchema: z.object({ page: z.number() }),
  callback: ({ page }) =>
    Array.from(
      { length: 45 },
      (_, line) => `Page ${page}, line ${line}: step ${page * 100 + line} of the assembly, torque ${(line % 7) + 3} Nm.`
    ).join('\n'),
})

// With cache points a request re-reads nearly all of the previous request (measured: 0.99 or more).
const MIN_READ_FRACTION = 0.9

// A fresh agent shares the system prompt and tool specs with the first one, not its first message (measured: 0.95).
const MIN_FRESH_READ_FRACTION = 0.8

const read = (usage: Usage): number => usage.cacheReadInputTokens ?? 0
const write = (usage: Usage): number => usage.cacheWriteInputTokens ?? 0
// Providers count cached tokens inside inputTokens or beside them; the total holds either way.
const promptTokens = (usage: Usage): number => usage.totalTokens - usage.outputTokens

describe('caching', () => {
  useWorkDir()

  it('reads most of the previous request from cache on every request after the first turn', async (context) => {
    // Unique per run, so that cache entries an earlier attempt wrote (they live five minutes) cannot satisfy this one.
    const instructions = `Run ${randomUUID()}. ${STABLE_PREFIX}`
    const build = (): Promise<Agent> =>
      buildAgent({ instructions, tools: [fetchPage], builtinPlugins: ['environment'] })
    const agent = await build()
    const caching = agent.model.modelInfo.capabilities?.promptCaching
    context.skip(caching !== 'cachePoints' && caching !== 'auto', 'the harness does not cache prompts on this model')
    const recording = record(agent)
    onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', 'caching.json')))

    const turn = (page: number): Promise<unknown> =>
      agent.invoke(`${TESTING} Call fetch_page with page ${page}, then reply with exactly the word: done.`)
    await turn(1)
    const firstTurnCalls = recording.loopCalls.length
    for (const page of [2, 3, 4]) {
      await turn(page)
    }

    checkInvariants(recording, agent)
    const usage = recording.loopCalls.map((call) => call.usage!)
    if (caching !== 'cachePoints') {
      expect(read(usage.at(-1)!), JSON.stringify(usage)).toBeGreaterThan(0)
      return
    }
    // A request reads again all that the previous one read or cached, which is most of that request.
    const misses = usage.slice(firstTurnCalls).filter((current, index) => {
      const previous = usage[firstTurnCalls + index - 1]!
      return read(current) < Math.max(read(previous) + write(previous), MIN_READ_FRACTION * promptTokens(previous))
    })
    expect(misses.length, JSON.stringify(usage)).toBeLessThanOrEqual(1)

    // A second conversation can share only what has its own cache point: here, the system prompt and tools.
    if (!(agent.model instanceof BedrockModel || agent.model instanceof AnthropicModel)) {
      return
    }
    const fresh = await build()
    recording.attach(fresh.model)
    await fresh.invoke(`${TESTING} Reply with exactly the word: ready.`)
    checkInvariants(recording, fresh)
    const cached = read(usage[0]!) + write(usage[0]!)
    expect(read(recording.loopCalls[usage.length]!.usage!)).toBeGreaterThanOrEqual(MIN_FRESH_READ_FRACTION * cached)
  })
})
