import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import { isolateDevState } from '../../src/dev/runtime.js'

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
      ...options,
      session: { dir: join('/workspace', '.strands/state/sessions') },
      memory: { dir: join('/workspace', '.strands/state/memory') },
    })
    expect(options.session.dir).toBe('/old/sessions')
  })

  it('shouldKeepStateDisabledWhenTheSourceDisablesIt', () => {
    expect(isolateDevState({ session: false, memory: false }, '/workspace')).toEqual({ session: false, memory: false })
  })

  it.each(['sessionManager', 'memoryManager', 'storage'])('shouldRejectCustomStateWhenTheSourceSets%s', (field) => {
    expect(() => isolateDevState({ [field]: {} } as HarnessAgentOptions, '/workspace')).toThrow('cannot isolate custom')
  })
})
