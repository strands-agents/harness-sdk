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
    expect(internal.PROVIDER_ENDPOINTS).toEqual({
      anthropic: {
        baseUrlEnvironmentKey: 'ANTHROPIC_BASE_URL',
        defaultBaseUrl: 'https://api.anthropic.com',
      },
      openai: {
        baseUrlEnvironmentKey: 'OPENAI_BASE_URL',
        defaultBaseUrl: 'https://api.openai.com/v1',
      },
      google: {
        baseUrlEnvironmentKey: 'GOOGLE_GEMINI_BASE_URL',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com',
      },
    })
  })

  it('keeps that plumbing off the root surface', () => {
    for (const name of [
      'resolveModel',
      'PROVIDER_ENDPOINTS',
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
