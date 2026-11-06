import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import type { AgentStreamEvent } from '@strands-agents/sdk'
import { CliConfigStore } from '../src/tui/config.js'
import {
  harnessSystemPrompt,
  SAVED_SYSTEM_PROMPT,
  SystemPromptRecordingModel,
  writeSessionWithSavedSystemPrompt,
} from './fixtures/saved-system-prompt.js'

const createHarness = vi.hoisted(() => vi.fn())
vi.mock('@strands-agents/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@strands-agents/harness')>()),
  createHarness,
  configureLogging: vi.fn(),
}))

const { main } = await import('../src/cli/run.js')

function fakeAgent(): { sent: string[] } & {
  addHook: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
  stream: (message: string) => AsyncGenerator<AgentStreamEvent, unknown>
} {
  const sent: string[] = []
  async function* stream(message: string): AsyncGenerator<AgentStreamEvent, unknown> {
    sent.push(message)
    yield textEvent
    return { metrics: { accumulatedUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }
  }
  return { sent, stream, addHook: vi.fn(), initialize: vi.fn(async () => undefined) }
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

  it('keeps the CLI system prompt when --session-id resumes a session that saved a different one', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'strands-print-system-prompt-'))
    await writeSessionWithSavedSystemPrompt(join(workspace, '.agent', 'sessions'), 'saved-session')
    const model = new SystemPromptRecordingModel()
    const harness = await vi.importActual<typeof import('@strands-agents/harness')>('@strands-agents/harness')
    createHarness.mockImplementation((options: HarnessAgentOptions) =>
      harness.createHarness({
        ...options,
        model,
        builtinTools: [],
        builtinPlugins: [],
        contextManager: false,
        memory: false,
        skills: false,
      })
    )
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)

    try {
      await main(['-p', 'continue', '--session-id', 'saved-session'])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }

    expect(errWrites.join('')).toBe('')
    expect(model.systemPrompts).toEqual([harnessSystemPrompt()])
    expect(model.systemPrompts[0]).not.toContain(SAVED_SYSTEM_PROMPT)
    expect(model.firstMessageTexts).toEqual(['earlier request'])
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
