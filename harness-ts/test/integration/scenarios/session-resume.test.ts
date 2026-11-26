import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed } from 'vitest'

import { checkInvariants, record, stablePrefix, wire } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent, toolSucceeded } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

describe('session resume', () => {
  useWorkDir()

  it("recalls the first agent's codeword and keeps calling tools from an agent rebuilt on the session", async () => {
    const first = await buildAgent({ session: { id: 'resume' } })
    const recording = record(first)
    onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', 'session-resume.json')))
    await first.invoke(
      `${TESTING} Remember this codeword for later: QUOKKA-58. Then use the shell tool to run \`echo ready\` and reply with its output.`
    )
    expect(toolSucceeded(first, 'shell')).toBe(true)

    const second = await buildAgent({ session: { id: 'resume' } })
    recording.attach(second.model)
    const resumedAt = recording.calls.length
    await second.invoke(
      `${TESTING} Use the write tool to save the codeword I asked you to remember, and nothing else, to ${join(process.cwd(), 'codeword.txt')}.`
    )

    expect(readFileSync('codeword.txt', 'utf8').trim()).toBe('QUOKKA-58')
    expect(stablePrefix(recording.calls[resumedAt]!).slice(0, -1)).toEqual(wire(first.messages))
    checkInvariants(recording, second)
  })
})
