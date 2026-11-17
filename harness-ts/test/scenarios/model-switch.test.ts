import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createHarness } from '../../src/agent.js'
import { checkInvariants, record, stablePrefix } from './recording.js'
import { ScriptedModel } from './scripted-model.js'
import { useWorkDir } from './work-dir.js'

describe('model switch', () => {
  const workDir = useWorkDir()

  it('hands each model the whole prior conversation when agent.model is reassigned', { timeout: 30_000 }, async () => {
    const notes = join(workDir(), 'notes.txt')
    writeFileSync(notes, 'alpha\n')
    const modelA = new ScriptedModel(
      [
        { reasoning: 'I should read it.', signature: 'signed-by-a', toolUses: [['read', { path: notes }]] },
        'read',
        'back on a',
      ],
      { modelId: 'model-a' }
    )
    const modelB = new ScriptedModel([[['shell', { command: 'cat notes.txt' }]], 'still alpha'], { modelId: 'model-b' })
    const agent = await createHarness({ model: modelA, memory: false, printer: false })
    const recording = record(agent)
    recording.attach(modelB)

    await agent.invoke('Read notes.txt.')
    agent.model = modelB
    await agent.invoke('Check it again.')
    agent.model = modelA
    await agent.invoke('Thanks.')
    modelA.assertExhausted()
    modelB.assertExhausted()

    expect(recording.calls.map((call) => call.modelId)).toEqual(['model-a', 'model-a', 'model-b', 'model-b', 'model-a'])
    const success = (toolUseId: string, content: object): object => ({
      role: 'user',
      content: [{ toolResult: { toolUseId, status: 'success', content: [content] } }],
    })
    const turnOnA = [
      { role: 'user', content: [{ text: 'Read notes.txt.' }] },
      {
        role: 'assistant',
        content: [
          { reasoning: { text: 'I should read it.', signature: 'signed-by-a' } },
          { toolUse: { name: 'read', toolUseId: 'model-a-1-0', input: { path: notes } } },
        ],
      },
      success('model-a-1-0', { text: '     1\talpha\n     2\t' }),
      { role: 'assistant', content: [{ text: 'read' }] },
    ]
    const turnOnB = [
      { role: 'user', content: [{ text: 'Check it again.' }] },
      {
        role: 'assistant',
        content: [{ toolUse: { name: 'shell', toolUseId: 'model-b-1-0', input: { command: 'cat notes.txt' } } }],
      },
      success('model-b-1-0', { json: { output: expect.stringMatching(/^alpha\r?\n$/), error: '', exit_code: 0 } }),
      { role: 'assistant', content: [{ text: 'still alpha' }] },
    ]
    expect(stablePrefix(recording.calls[2]!)).toEqual([
      ...turnOnA,
      { role: 'user', content: [{ text: 'Check it again.' }] },
    ])
    expect(stablePrefix(recording.calls[4]!)).toEqual([
      ...turnOnA,
      ...turnOnB,
      { role: 'user', content: [{ text: 'Thanks.' }] },
    ])
    checkInvariants(recording, agent)
  })
})
