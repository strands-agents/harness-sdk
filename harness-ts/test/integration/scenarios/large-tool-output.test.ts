import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from '@strands-agents/sdk'
import { describe, expect, it, onTestFailed } from 'vitest'
import { z } from 'zod'

import { checkInvariants, record } from '../../scenarios/recording.js'
import { useWorkDir } from '../../scenarios/work-dir.js'
import { buildAgent, toolSucceeded } from '../harness.js'

const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

// The codeword sits mid-log: an offloaded result's preview keeps the head and the tail.
const LOG = Array.from({ length: 2000 }, (_, line) =>
  line === 1000 ? 'CODEWORD: NARWHAL-26' : `entry ${line}: heartbeat ok, nothing to report.`
).join('\n')

const fetchLog = tool({
  name: 'fetch_log',
  description: 'Fetches the full service log.',
  inputSchema: z.object({}),
  callback: () => LOG,
})

describe('large tool output', () => {
  useWorkDir()

  it('keeps a huge tool result out of the requests yet lets the model find a line inside it', async () => {
    // Without the programmatic tool caller, the only way into an offloaded result is its reference.
    const agent = await buildAgent({ tools: [fetchLog], builtinTools: ['shell', 'read', 'write', 'edit', 'web_fetch'] })
    const recording = record(agent)
    onTestFailed(() => recording.dump(join(tmpdir(), 'strands-scenarios', 'large-tool-output.json')))

    const result = await agent.invoke(
      `${TESTING} Call fetch_log. One line of the log starts with "CODEWORD:". Reply with that line. ` +
        'The log is long, so search it for that pattern rather than reading it whole.'
    )

    expect(result.toString()).toContain('NARWHAL-26')
    expect(toolSucceeded(agent, 'retrieve_context')).toBe(true)
    const largest = Math.max(...recording.calls.map((call) => JSON.stringify(call.messages).length))
    expect(largest).toBeLessThan(LOG.length / 4)
    checkInvariants(recording, agent)
  })
})
