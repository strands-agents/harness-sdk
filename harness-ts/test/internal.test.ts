import { describe, expect, it } from 'vitest'

import * as internal from '../src/internal.js'
import * as root from '../src/index.js'

describe('@strands-agents/harness/internal', () => {
  it('exposes the plumbing the CLI consumes', () => {
    for (const name of [
      'normalizeHarnessAgentConfig',
      'resolveModel',
      'resolveMemory',
      'resolveInterventions',
      'resolveBuiltinTools',
      'enabledBuiltinTools',
      'builtinToolConfig',
    ]) {
      expect(typeof (internal as Record<string, unknown>)[name], name).toBe('function')
    }
  })

  it('keeps that plumbing off the root surface', () => {
    for (const name of [
      'resolveModel',
      'resolveMemory',
      'resolveInterventions',
      'resolveBuiltinTools',
      'EFFORT_LEVELS',
      'DEFAULT_MEMORY_DIR',
      'DEFAULT_SKILLS_DIR',
    ]) {
      expect(root, name).not.toHaveProperty(name)
    }
  })
})
