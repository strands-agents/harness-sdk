import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createHarness } from '../../src/agent.js'
import { checkInvariants, record, stablePrefix } from './recording.js'
import { ScriptedModel } from './scripted-model.js'
import { useWorkDir } from './work-dir.js'

describe('session resume', () => {
  const workDir = useWorkDir()

  it(
    "sends the first agent's conversation unchanged, then the new message, from an agent rebuilt on the session",
    { timeout: 30_000 },
    async () => {
      const notes = join(workDir(), 'notes.txt')
      writeFileSync(notes, 'alpha\n')
      const session = { id: 'resume' }
      const todos = [{ content: 'Keep notes', activeForm: 'Keeping notes', status: 'in_progress' }]
      const firstModel = new ScriptedModel(
        [{ reasoning: 'I should read it.', toolUses: [['read', { path: notes }]] }, 'read', 'noted'],
        { modelId: 'first' }
      )
      const first = await createHarness({ model: firstModel, session, memory: false, printer: false })
      first.appState.set('todos', todos)
      const recording = record(first)
      await first.invoke('Read notes.txt.')
      await first.invoke('Remember it.')
      firstModel.assertExhausted()

      const secondModel = new ScriptedModel([[['shell', { command: 'cat notes.txt' }]], 'still alpha'], {
        modelId: 'second',
      })
      const second = await createHarness({ model: secondModel, session, memory: false, printer: false })
      recording.attach(secondModel)
      await second.invoke('Check it again.')
      secondModel.assertExhausted()

      const thirdModel = new ScriptedModel(['hello'], { modelId: 'third' })
      const third = await createHarness({ model: thirdModel, session, memory: false, printer: false })
      recording.attach(thirdModel)
      await third.invoke('Hi.')
      thirdModel.assertExhausted()

      const success = (toolUseId: string, content: unknown): unknown => ({
        role: 'user',
        content: [{ toolResult: { toolUseId, status: 'success', content: [content] } }],
      })
      const firstTurns = [
        { role: 'user', content: [{ text: 'Read notes.txt.' }] },
        {
          role: 'assistant',
          content: [
            { reasoning: { text: 'I should read it.', signature: 'scripted-signature' } },
            { toolUse: { name: 'read', toolUseId: 'first-1-0', input: { path: notes } } },
          ],
        },
        success('first-1-0', { text: '     1\talpha\n     2\t' }),
        { role: 'assistant', content: [{ text: 'read' }] },
        { role: 'user', content: [{ text: 'Remember it.' }] },
        { role: 'assistant', content: [{ text: 'noted' }] },
      ]
      const secondTurn = [
        { role: 'user', content: [{ text: 'Check it again.' }] },
        {
          role: 'assistant',
          content: [{ toolUse: { name: 'shell', toolUseId: 'second-1-0', input: { command: 'cat notes.txt' } } }],
        },
        success('second-1-0', {
          // On Windows, PowerShell writes a progress record to stderr the first time it runs.
          json: { output: expect.stringMatching(/^alpha\r?\n$/), error: expect.any(String), exit_code: 0 },
        }),
        { role: 'assistant', content: [{ text: 'still alpha' }] },
      ]
      expect(stablePrefix(recording.calls[3]!)).toEqual([...firstTurns, secondTurn[0]])
      expect(recording.calls[3]!.systemPrompt).toEqual(recording.calls[0]!.systemPrompt)
      expect(second.appState.get('todos')).toEqual(todos)
      expect(stablePrefix(recording.calls[5]!)).toEqual([
        ...firstTurns,
        ...secondTurn,
        { role: 'user', content: [{ text: 'Hi.' }] },
      ])
      checkInvariants(recording, third)
    }
  )
})
