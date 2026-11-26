import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@strands-agents/sdk'
import { describe, expect, it, onTestFailed, type TestContext } from 'vitest'

import { supportsThinking } from '../../../src/models.js'
import type { Effort } from '../../../src/types/agent.js'
import { checkInvariants, record, type Recording, wire } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent, INTEG_MODEL, toolSucceeded } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

// A different model family, so the conversation crosses a provider-format boundary.
const SWITCH_MODEL = process.env.STRANDS_INTEG_SWITCH_MODEL ?? 'bedrock/us.openai.gpt-6-luna'

// Reasoning blocks crossing the boundary are the risk, so the first model also runs with thinking on.
const EFFORTS: Effort[] = supportsThinking(INTEG_MODEL) ? ['off', 'low'] : ['off']

/** Runs one turn and requires `model`, a "provider/name" spec, to have served every request of it. */
async function turn(agent: Agent, recording: Recording, model: string, prompt: string): Promise<void> {
  const before = recording.loopCalls.length
  await agent.invoke(`${TESTING} ${prompt}`)
  const served = recording.loopCalls.slice(before).map((call) => call.modelId)
  expect(new Set(served)).toEqual(new Set([model.slice(model.indexOf('/') + 1)]))
}

async function readCodeword(agent: Agent, recording: Recording): Promise<void> {
  // The codeword enters the conversation only inside a tool result, and its file is gone before the switch.
  const source = join(process.cwd(), 'codeword.txt')
  writeFileSync(source, 'AXOLOTL-64\n')
  await turn(agent, recording, INTEG_MODEL, `Use the read tool to read ${source}, then reply with exactly: ok.`)
  rmSync(source)
  expect(toolSucceeded(agent, 'read')).toBe(true)
  const spoken = wire(agent.messages).flatMap(({ content }) =>
    content.flatMap((block) => ('text' in block ? [block.text] : []))
  )
  expect(spoken.join('\n')).not.toContain('AXOLOTL-64')
}

function skipUnlessReasoningCrosses(context: TestContext, agent: Agent, effort: Effort): void {
  const reasoned = wire(agent.messages).some((message) => message.content.some((block) => 'reasoning' in block))
  context.skip(
    effort !== 'off' && !reasoned,
    'the model answered without reasoning, so no reasoning block would cross the switch'
  )
}

async function saveCodeword(agent: Agent, recording: Recording, model: string, file: string): Promise<void> {
  await turn(
    agent,
    recording,
    model,
    `The file you read earlier is deleted. Use the write tool to save the codeword it held, and nothing else, to ${join(process.cwd(), file)}.`
  )
  expect(readFileSync(file, 'utf8').trim()).toBe('AXOLOTL-64')
}

describe('model switch', () => {
  useWorkDir()

  it.for(EFFORTS)(
    'recalls the codeword and calls tools on both models when agent.model is reassigned (effort %s)',
    async (effort, context) => {
      const agent = await buildAgent({ effort })
      const original = agent.model
      const { model: other } = await buildAgent({ model: SWITCH_MODEL })
      const recording = record(agent)
      recording.attach(other)
      onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', `model-switch-in-place-${effort}.json`)))

      await readCodeword(agent, recording)
      skipUnlessReasoningCrosses(context, agent, effort)
      agent.model = other
      await saveCodeword(agent, recording, SWITCH_MODEL, 'switched.txt')
      agent.model = original
      await saveCodeword(agent, recording, INTEG_MODEL, 'back.txt')

      expect(new Set(recording.calls.map((call) => call.model)).size).toBe(2)
      checkInvariants(recording, agent)
    }
  )

  it.for(EFFORTS)(
    'recalls the codeword and calls tools on both models when the agent is rebuilt on the session (effort %s)',
    async (effort, context) => {
      const session = { id: 'switch' }
      const first = await buildAgent({ effort, session })
      const recording = record(first)
      onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', `model-switch-rebuild-${effort}.json`)))
      await readCodeword(first, recording)
      skipUnlessReasoningCrosses(context, first, effort)

      const second = await buildAgent({ model: SWITCH_MODEL, session })
      recording.attach(second.model)
      await saveCodeword(second, recording, SWITCH_MODEL, 'switched.txt')

      const third = await buildAgent({ effort, session })
      recording.attach(third.model)
      await saveCodeword(third, recording, INTEG_MODEL, 'back.txt')

      expect(new Set(recording.calls.map((call) => call.model)).size).toBe(3)
      checkInvariants(recording, third)
    }
  )
})
