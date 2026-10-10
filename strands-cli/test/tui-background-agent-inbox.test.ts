import type { LocalAgent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { BackgroundAgentInbox } from '../src/tui/background/inbox.js'
import { LiveSteering } from '../src/tui/steering.js'

describe('BackgroundAgentInbox', () => {
  it('handles child discovery before the task record is linked', async () => {
    const inbox = new BackgroundAgentInbox()
    const events: unknown[] = []
    inbox.subscribe((event) => events.push(event))

    inbox.start('tool-1', 'subagent', 'Inspect authentication.')
    await inbox.run('tool-1', async () => {
      inbox.observeAgent(() => true)
    })
    expect(events).toEqual([])

    inbox.linkTask('task-1', 'tool-1')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'available',
      endpoint: { taskId: 'task-1' },
    })
  })

  it('keeps the first observed agent as the task recipient', async () => {
    const inbox = new BackgroundAgentInbox()
    const root = vi.fn(() => true)
    const nested = vi.fn(() => true)

    inbox.start('tool-1', 'subagent', 'Inspect authentication.')
    inbox.linkTask('task-1', 'tool-1')
    await inbox.run('tool-1', async () => {
      inbox.observeAgent(root)
      inbox.observeAgent(nested)
    })

    expect(inbox.send('task-1', 'Check the authorization path.')).toBe(true)
    expect(root).toHaveBeenCalledWith('Check the authorization path.')
    expect(nested).not.toHaveBeenCalled()
  })

  it('rejects messages after the observed child closes', async () => {
    const inbox = new BackgroundAgentInbox()
    const events: unknown[] = []
    inbox.subscribe((event) => events.push(event))

    inbox.start('tool-1', 'subagent', 'Inspect authentication.')
    inbox.linkTask('task-1', 'tool-1')
    const close = await inbox.run('tool-1', async () => inbox.observeAgent(() => true))
    close?.()

    expect(inbox.send('task-1', 'Too late.')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'unavailable', taskId: 'task-1' })
  })

  it('stays available when final-boundary steering resumes the child', async () => {
    type FinalEvent = {
      agent: LocalAgent
      _getResult(): { stopReason: string }
      resume: string | undefined
    }
    const inbox = new BackgroundAgentInbox()
    const callbacks: ((event: FinalEvent) => void)[] = []
    const child = {
      messages: [],
      addHook: vi.fn((_event, callback: (event: FinalEvent) => void) => {
        callbacks.push(callback)
        return () => {}
      }),
    } as unknown as LocalAgent
    let steering!: LiveSteering
    steering = new LiveSteering((candidate) => {
      return inbox.observeAgent((prompt) => steering.enqueue(candidate, prompt))
    })

    inbox.start('tool-1', 'subagent', 'Inspect authentication.')
    inbox.linkTask('task-1', 'tool-1')
    await inbox.run('tool-1', async () => {
      steering.observeAgent(child)
    })
    expect(inbox.send('task-1', 'Check the final result.')).toBe(true)
    const event: FinalEvent = {
      agent: child,
      _getResult: () => ({ stopReason: 'endTurn' }),
      resume: undefined,
    }

    for (const callback of callbacks) {
      callback(event)
    }
    await Promise.resolve()

    expect(event.resume).toBe('Check the final result.')
    expect(inbox.send('task-1', 'One more check.')).toBe(true)
  })
})
