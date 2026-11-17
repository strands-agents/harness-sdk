import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from '@strands-agents/sdk'
import { describe, expect, it, onTestFailed } from 'vitest'
import { z } from 'zod'

import { checkInvariants, record } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

describe('tool failure', () => {
  useWorkDir()

  it('retries a tool that failed transiently and answers from its second result', async () => {
    let calls = 0
    const fetchCodeword = tool({
      name: 'fetch_codeword',
      description: 'Fetches the codeword from a remote service.',
      inputSchema: z.object({}),
      callback: () => {
        calls++
        if (calls === 1) {
          throw new Error('Transient network error, retry the call.')
        }
        return 'The codeword is WOMBAT-41.'
      },
    })
    const agent = await buildAgent({ tools: [fetchCodeword] })
    const recording = record(agent)
    onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', 'tool-failure.json')))

    const result = await agent.invoke(`${TESTING} Call fetch_codeword and reply with the codeword it returns.`)

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(result.toString()).toContain('WOMBAT-41')
    checkInvariants(recording, agent, { allowedToolErrors: ['fetch_codeword'] })
  })
})
