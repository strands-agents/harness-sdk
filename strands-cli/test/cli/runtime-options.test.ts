import { createHarness } from '@strands-agents/harness'
import { MemoryManager, SessionManager, TextBlock } from '@strands-agents/sdk'
import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { runtimeAgentFactory, runtimeOptions, workspaceStateDirectory } from '../../src/cli/runtime-options.js'
import { initializeAgentDefinition } from '../../src/session/agent-definition.js'
import { strandsUserPath } from '../../src/paths.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { SystemPromptRecordingModel, writeSessionWithSavedSystemPrompt } from '../fixtures/saved-system-prompt.js'

afterEach(() => vi.unstubAllEnvs())

it('relocates enabled file stores by workspace and preserves disabled or explicit native stores', async () => {
  const workspace = await temporaryDirectory()
  const other = await temporaryDirectory()
  const home = await temporaryDirectory()
  vi.stubEnv('STRANDS_CLI_HOME', home)
  const defaults = runtimeOptions({}, workspace)
  expect(defaults).toEqual({
    session: { dir: join(workspaceStateDirectory(workspace), 'sessions') },
    memory: { dir: join(workspaceStateDirectory(workspace), 'memory') },
  })
  expect(strandsUserPath('settings.toml')).toBe(join(home, 'settings.toml'))
  const root = join(home, 'override')
  const moved = runtimeOptions({ session: { id: 'saved', dir: '/unused' }, memory: false }, workspace, {
    stateDir: root,
  })
  expect(moved).toEqual({
    session: { id: 'saved', dir: join(workspaceStateDirectory(workspace, root), 'sessions') },
    memory: false,
  })
  expect(runtimeOptions({ session: false, memory: null }, workspace, { stateDir: root })).toEqual({
    session: false,
    memory: null,
  })
  expect(runtimeOptions(defaults, other, {}, workspace)).toEqual(runtimeOptions({}, other))
  expect(runtimeOptions({ session: { dir: '/explicit' } }, workspace).session).toEqual({ dir: '/explicit' })
  const memory = new MemoryManager({ stores: [new TestMemoryStore({ name: 'custom', persist: false })] })
  for (const options of [
    { session: new SessionManager({ sessionId: 'custom' }) },
    { memory },
    { memoryManager: memory, memory: false as const },
  ]) {
    expect(() => runtimeOptions(options, workspace, { stateDir: root })).toThrow('cannot relocate a custom')
  }
})

it.each(['Custom prompt', [new TextBlock('Custom prompt')]])(
  'appends instructions once after restoration without persisting them (%j)',
  async (systemPrompt) => {
    const directory = await temporaryDirectory()
    const model = new SystemPromptRecordingModel()
    await writeSessionWithSavedSystemPrompt(directory, 'saved')
    const options = {
      model,
      systemPrompt,
      session: { id: 'saved', dir: directory },
      memory: false,
      skills: false,
      builtinTools: [] as const,
      builtinPlugins: [] as const,
      printer: false,
    }
    const agent = await createHarness(options)
    const factory = runtimeAgentFactory({ appendInstructions: 'Run-only suffix' }, async () => agent)
    try {
      await factory(options)
      await factory(options)
      await initializeAgentDefinition(agent)
      await agent.invoke('first')
      await agent.invoke('second')
      const expected = Array.isArray(systemPrompt)
        ? [...systemPrompt, new TextBlock('Run-only suffix')]
        : `${systemPrompt}\n\nRun-only suffix`
      expect(model.systemPrompts).toEqual([expected, expected])
      expect(agent.systemPrompt).toEqual(systemPrompt)
      await agent.shutdown()
      const saved = await readFile(
        join(directory, 'saved', 'scopes', 'agent', 'agent', 'snapshots', 'snapshot_latest.json'),
        'utf8'
      )
      expect(saved).not.toContain('Run-only suffix')
    } finally {
      await agent.shutdown()
    }
  }
)
