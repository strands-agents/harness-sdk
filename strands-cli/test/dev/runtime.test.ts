import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import { MemoryManager, SessionManager } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'
import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'
import { devStateNotice, isolateDevState } from '../../src/dev/runtime.js'

const sessionManager = (): SessionManager => new SessionManager({ sessionId: 'own' })
const memoryStore = (): TestMemoryStore =>
  new TestMemoryStore({ name: 'own', path: '/agent/memory.json', extraction: false })
const memoryManager = (): MemoryManager => new MemoryManager({ stores: [memoryStore()] })

describe('isolateDevState', () => {
  it('shouldUseWorkspaceStorageWhenSourceUsesOtherPaths', () => {
    const options = {
      name: 'local',
      model: 'model',
      instructions: 'keep',
      session: { dir: '/old/sessions' },
      memory: { dir: '/old/memory' },
    }

    const isolated = isolateDevState(options, '/workspace')

    expect(isolated).toEqual({
      options: {
        ...options,
        session: { dir: join('/workspace', '.strands/state/sessions') },
        memory: { dir: join('/workspace', '.strands/state/memory') },
      },
      turnedOff: [],
    })
    expect(options.session.dir).toBe('/old/sessions')
  })

  it.each([false, null])('shouldKeepStateDisabledWhenTheSourceSetsIt %s', (value) => {
    expect(isolateDevState({ session: value, memory: value }, '/workspace')).toEqual({
      options: { session: false, memory: false },
      turnedOff: [],
    })
  })

  it.each<[string, HarnessAgentOptions, string]>([
    ['sessionManager', { sessionManager: sessionManager() }, 'session'],
    ['a SessionManager as session', { session: sessionManager() }, 'session'],
    ['memoryManager', { memoryManager: memoryManager() }, 'memory'],
    ['a MemoryManager as memory', { memory: memoryManager() }, 'memory'],
    ['memory stores', { memory: { stores: [memoryStore()] } }, 'memory'],
  ])('shouldTurnOffTheCustomStateWhenTheSourceSets %s', (_case, options, manager) => {
    const isolated = isolateDevState(options, '/workspace')

    expect(isolated.turnedOff).toEqual([manager])
    expect(isolated.options[manager as 'session' | 'memory']).toBe(false)
    expect(isolated.options.sessionManager).toBeUndefined()
    expect(isolated.options.memoryManager).toBeUndefined()
  })

  it('shouldClearTheCustomStorageWhileTheSessionMovesToTheWorkspace', () => {
    const isolated = isolateDevState({ storage: new InMemoryStorage() }, '/workspace')

    expect(isolated.turnedOff).toEqual(['storage'])
    expect(isolated.options).toHaveProperty('storage', undefined)
    expect(isolated.options.session).toEqual({ dir: join('/workspace', '.strands/state/sessions') })
  })

  it('shouldKeepTheClearedManagersAsKeysSoThatTheyOverrideTheAuthoredOptions', () => {
    const isolated = isolateDevState({ sessionManager: sessionManager(), memoryManager: memoryManager() }, '/workspace')

    expect(isolated.options).toHaveProperty('sessionManager', undefined)
    expect(isolated.options).toHaveProperty('memoryManager', undefined)
    expect(isolated.turnedOff).toEqual(['session', 'memory'])
  })
})

describe('devStateNotice', () => {
  it.each<[readonly ('session' | 'memory' | 'storage')[], string | undefined]>([
    [[], undefined],
    [
      ['storage'],
      'Dev deactivated the custom storage of this agent in this chat. Thus the chat cannot write into the stores of the agent.',
    ],
    [
      ['session', 'memory', 'storage'],
      'Dev deactivated the custom session manager, memory, and storage of this agent in this chat. Thus the chat cannot write into the stores of the agent. Dev does not save this chat.',
    ],
  ])('shouldDescribeWhatDevTurnedOffWhenTheListIs %j', (turnedOff, notice) => {
    expect(devStateNotice(turnedOff)).toBe(notice)
  })
})
