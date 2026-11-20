import { join } from 'node:path'
import { tool } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createHarness } from '../../src/agent.js'
import { checkInvariants, record } from './recording.js'
import { ScriptedModel } from './scripted-model.js'
import { useWorkDir } from './work-dir.js'

const explode = tool({
  name: 'explode',
  description: 'Always throws.',
  inputSchema: z.object({}),
  callback: () => {
    throw new Error('the disk is on fire')
  },
})

describe('tool failure', () => {
  const workDir = useWorkDir()

  it(
    'reports a failed built-in tool and a throwing custom tool to the model and finishes the turn',
    { timeout: 30_000 },
    async () => {
      const missing = join(workDir(), 'missing.txt')
      const model = new ScriptedModel([
        [
          ['read', { path: missing }],
          ['explode', {}],
        ],
        'both failed',
      ])
      const agent = await createHarness({ model, tools: [explode], memory: false, printer: false })
      const recording = record(agent)

      const result = await agent.invoke('Read missing.txt and explode.')
      model.assertExhausted()

      expect(result.stopReason).toBe('endTurn')
      expect(recording.calls[1]!.messages.at(-1)).toEqual({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'scripted-1-0',
              status: 'error',
              content: [{ text: expect.stringMatching(/no such file.*missing\.txt/) }],
            },
          },
          {
            toolResult: {
              toolUseId: 'scripted-1-1',
              status: 'error',
              content: [{ text: 'Error: the disk is on fire' }],
            },
          },
        ],
      })
      checkInvariants(recording, agent, { allowedToolErrors: ['read', 'explode'] })
    }
  )
})
