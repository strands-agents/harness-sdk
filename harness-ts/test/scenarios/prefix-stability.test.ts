import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createHarness } from '../../src/agent.js'
import { HARNESS_CONTRACT } from '../../src/prompt.js'
import { checkInvariants, record, wire } from './recording.js'
import { ScriptedModel } from './scripted-model.js'
import { useWorkDir } from './work-dir.js'

// A few hundred characters: too small to be offloaded, large enough that a truncated result loses its last line.
const NOTES =
  Array.from({ length: 12 }, (_, line) => `note ${line}: keep the scenario notes long enough to matter.\n`).join('') +
  'end-of-notes\n'

describe('prefix stability', () => {
  const workDir = useWorkDir()

  it(
    'sends a byte-identical system prompt, tool specs and earlier messages on every request',
    { timeout: 30_000 },
    async () => {
      const notes = join(workDir(), 'notes.txt')
      const copy = join(workDir(), 'copy.txt')
      writeFileSync(notes, NOTES)
      writeFileSync('AGENTS.md', 'Keep answers short.\n')
      const model = new ScriptedModel([
        [['read', { path: notes }]],
        'read',
        [
          ['write', { path: copy, content: 'beta\n' }],
          ['shell', { command: 'cat copy.txt' }],
        ],
        'written',
        [['todo_write', { todos: [{ content: 'Copy notes', activeForm: 'Copying notes', status: 'completed' }] }]],
        'done',
      ])
      // Memory is off in the offline scenarios to match Python, where a fact-extraction request follows every turn.
      const agent = await createHarness({
        model,
        builtinPlugins: ['environment', 'todos'],
        memory: false,
        printer: false,
      })
      agent.appState.set('todos', [{ content: 'Copy notes', activeForm: 'Copying notes', status: 'in_progress' }])
      const recording = record(agent)

      for (const prompt of ['Read notes.txt.', 'Copy it to copy.txt.', 'Mark the todo done.']) {
        await agent.invoke(prompt)
      }
      model.assertExhausted()

      checkInvariants(recording, agent, { prefixBreaks: 0 })
      expect(recording.calls).toHaveLength(6)
      expect(recording.calls[0]!.systemPrompt).toContain(HARNESS_CONTRACT)
      expect(recording.calls[0]!.toolSpecs!.map((spec) => spec.name).sort()).toEqual([
        'edit',
        'programmatic_tool_caller',
        'read',
        'retrieve_context',
        'shell',
        'strands_manage_background_task',
        'subagent',
        'todo_write',
        'web_fetch',
        'write',
      ])
      const descriptions = recording.calls[0]!.toolSpecs!.map((spec) => [spec.name, spec.description])
      expect(descriptions).toEqual(agent.toolRegistry.list().map((tool) => [tool.name, tool.description]))
      expect(descriptions.every(([, description]) => description)).toBe(true)
      expect(new Set(recording.calls.map((call) => JSON.stringify([call.systemPrompt, call.toolSpecs]))).size).toBe(1)
      expect(readFileSync(copy, 'utf8')).toBe('beta\n')
      expect(JSON.stringify(recording.calls[1]!.messages.at(-1))).toContain('end-of-notes')

      // The injected reminders reach every request yet never enter the conversation they would rewrite.
      const reminders = recording.calls.map(({ messages, dynamicTrailingBlocks }) => {
        const { content } = messages.at(-1)!
        const trailing = content.slice(content.length - dynamicTrailingBlocks) as { text?: string }[]
        return trailing.map((block) => block.text ?? '').join('')
      })
      // The environment reminder joins the todo reminder on the first request of each turn.
      expect(recording.calls.map((call) => call.dynamicTrailingBlocks)).toEqual([2, 1, 2, 1, 2, 1])
      expect(reminders.every((reminder) => reminder.includes('Your current todo list'))).toBe(true)
      expect(reminders[0]).toContain('[in_progress] Copying notes')
      for (const turnStart of [reminders[0], reminders[2], reminders[4]]) {
        expect(turnStart).toContain('Keep answers short.')
        expect(turnStart).toContain('Date: ')
        expect(turnStart).toContain(`Working directory: ${process.cwd()}`)
      }
      expect(reminders[5]).toContain('[completed] Copy notes')
      expect(JSON.stringify(wire(agent.messages))).not.toContain('system-reminder')
    }
  )
})
