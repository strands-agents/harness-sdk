import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, type AgentStreamEvent } from '@strands-agents/sdk'
import { CliConfigStore } from '../../src/config/store.js'
import type { runInkChat } from '../../src/ui/run.js'

const createHarness = vi.hoisted(() => vi.fn())
const interactive = vi.hoisted(() => ({ run: vi.fn(), createTypescriptChat: vi.fn() }))
vi.mock('../../src/terminal/ink.js', () => ({}))
vi.mock('../../src/ui/run.js', () => ({ runInkChat: interactive.run }))
vi.mock('../../src/ui/chat/runtime.js', () => ({ createTypescriptChat: interactive.createTypescriptChat }))
vi.mock('@strands-agents/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@strands-agents/harness')>()),
  createHarness,
  configureLogging: vi.fn(),
}))

const { main } = await import('../../src/cli/run.js')

function fakeAgent(): { sent: string[] } & {
  addHook: ReturnType<typeof vi.fn>
  shutdown: Agent['shutdown']
  stream: (message: string) => AsyncGenerator<AgentStreamEvent, unknown>
} {
  const sent: string[] = []
  async function* stream(message: string): AsyncGenerator<AgentStreamEvent, unknown> {
    sent.push(message)
    yield textEvent
    return { metrics: { accumulatedUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }
  }
  return { sent, stream, addHook: vi.fn(), shutdown: Agent.prototype.shutdown }
}

const textEvent = {
  type: 'modelStreamUpdateEvent',
  event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } },
} as AgentStreamEvent

let writes: string[]
let errWrites: string[]

beforeEach(() => {
  writes = []
  errWrites = []
  vi.spyOn(CliConfigStore, 'load').mockResolvedValue(CliConfigStore.memory())
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    writes.push(typeof c === 'string' ? c : Buffer.from(c).toString())
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    errWrites.push(typeof c === 'string' ? c : Buffer.from(c).toString())
    return true
  })
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  createHarness.mockReset()
  interactive.run.mockReset()
  interactive.createTypescriptChat.mockReset()
  process.exitCode = undefined
})

describe('main', () => {
  it.each(['flag', 'saved'] as const)(
    'routes an interactive TypeScript source from %s to the child runtime before evaluating it',
    async (selection) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'strands-main-source-')))
      const entrypoint = join(root, 'agent.ts')
      await writeFile(entrypoint, "throw new Error('Authored source must not execute in the UI process')\n")
      const config = CliConfigStore.memory({}, { mcpDiscovery: false })
      if (selection === 'saved') await config.useAgentProject(entrypoint)
      vi.mocked(CliConfigStore.load).mockResolvedValue(config)
      const signal = new AbortController().signal
      const requestSetup = vi.fn()
      const childChat = {}
      interactive.createTypescriptChat.mockResolvedValue(childChat)
      interactive.run.mockImplementation(async (source: Parameters<typeof runInkChat>[0]) => {
        if (typeof source !== 'function') throw new Error('Expected the interactive startup factory')
        expect(await source(signal, requestSetup, undefined, undefined, async () => false)).toBe(childChat)
        return 0
      })
      const stdinTty = process.stdin.isTTY
      const stdoutTty = process.stdout.isTTY
      process.stdin.isTTY = true
      process.stdout.isTTY = true
      try {
        await main(selection === 'flag' ? ['--agent', entrypoint] : [])
        expect(process.exitCode, errWrites.join('')).toBe(0)
        expect(createHarness).not.toHaveBeenCalled()
        expect(interactive.createTypescriptChat).toHaveBeenCalledWith(
          entrypoint,
          config,
          expect.objectContaining({ cwd: process.cwd(), initialWorkspace: process.cwd(), mcpPaths: [] }),
          signal,
          requestSetup,
          undefined,
          undefined
        )
        expect(errWrites.join('')).not.toContain('Authored source must not execute')
      } finally {
        process.stdin.isTTY = stdinTty
        process.stdout.isTTY = stdoutTty
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('errors when one-shot has no request', async () => {
    // With a TTY stdin there's nothing to read, so -p with no request must error rather than block.
    const original = process.stdin.isTTY
    process.stdin.isTTY = true
    createHarness.mockResolvedValue(fakeAgent())
    try {
      await main(['-p'])
    } finally {
      process.stdin.isTTY = original
    }
    expect(process.exitCode).toBe(1)
    expect(errWrites.join('')).toContain('No request provided')
  })

  it('reports a construction error cleanly', async () => {
    createHarness.mockRejectedValue(new Error('Provider unavailable'))
    await main(['-p', 'hi', '--effort', 'high'])
    expect(process.exitCode).toBe(1)
    expect(createHarness).toHaveBeenCalledOnce()
    expect(errWrites.join('')).toContain('error: Provider unavailable')
  })
})
