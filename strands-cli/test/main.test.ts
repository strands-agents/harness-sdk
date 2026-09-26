import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '@strands-agents/sdk'
import { CliConfigStore } from '../src/tui/config.js'

const createHarness = vi.hoisted(() => vi.fn())
vi.mock('@strands-agents/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@strands-agents/harness')>()),
  createHarness,
  configureLogging: vi.fn(),
}))

const { main } = await import('../src/cli/run.js')

function fakeAgent(): { sent: string[] } & {
  addHook: ReturnType<typeof vi.fn>
  stream: (message: string) => AsyncGenerator<AgentStreamEvent, unknown>
} {
  const sent: string[] = []
  async function* stream(message: string): AsyncGenerator<AgentStreamEvent, unknown> {
    sent.push(message)
    yield textEvent
    return { metrics: { accumulatedUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }
  }
  return { sent, stream, addHook: vi.fn() }
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
  process.exitCode = undefined
})

describe('main', () => {
  it('runs a one-shot turn with --print', async () => {
    const agent = fakeAgent()
    createHarness.mockResolvedValue(agent)
    await main(['-p', 'do it'])
    expect(agent.sent).toEqual(['do it'])
    expect(writes.join('')).toContain('ok')
  })

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
    createHarness.mockRejectedValue(new Error("Thinking level 'bogus' is not supported by this provider."))
    await main(['-p', 'hi', '--effort', 'bogus'])
    expect(process.exitCode).toBe(1)
    expect(errWrites.join('')).toContain('effort must be one of')
  })

  it('honors commander exit for --help without treating it as an error', async () => {
    await main(['--help'])
    expect(process.exitCode).toBe(0)
    expect(errWrites.join('')).not.toContain('error:')
  })
})
