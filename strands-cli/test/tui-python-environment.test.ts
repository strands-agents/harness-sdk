import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyProviderEnvironmentValues, CliConfigStore } from '../src/tui/config.js'
import { PythonBackend } from '../src/tui/project/python.js'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(() => {
    throw new Error('Captured Python spawn')
  }),
}))

afterEach(() => {
  applyProviderEnvironmentValues({})
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('Python project environment', () => {
  it('ignores project dotenv and passes refreshed selected values without replacing shell values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strands-python-env-'))
    try {
      vi.stubEnv('OPENAI_API_KEY', 'shell-key')
      vi.stubEnv('ANTHROPIC_API_KEY', undefined)
      vi.stubEnv('projectToken', undefined)
      const path = join(root, '.env')
      await writeFile(path, 'ANTHROPIC_API_KEY=first\nOPENAI_API_KEY=file-key\nprojectToken=first')
      const config = CliConfigStore.memory()
      const project = { root, entrypoint: join(root, 'agent.py'), language: 'python' as const }
      const launch = async (): Promise<NodeJS.ProcessEnv> => {
        await expect(PythonBackend.open(project, config)).rejects.toThrow('Captured Python spawn')
        return vi.mocked(spawn).mock.calls.at(-1)![2]!.env!
      }
      const untrusted = await launch()
      expect(untrusted.ANTHROPIC_API_KEY).toBeUndefined()
      expect(untrusted.projectToken).toBeUndefined()
      config.useEnvironmentFiles([path])
      expect(await launch()).toMatchObject({ ANTHROPIC_API_KEY: 'first', projectToken: 'first' })
      await writeFile(path, 'ANTHROPIC_API_KEY=second')
      const refreshed = await launch()
      expect(refreshed.ANTHROPIC_API_KEY).toBe('second')
      expect(refreshed.OPENAI_API_KEY).toBe('shell-key')
      expect(refreshed.projectToken).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
