/**
 * A session-backed agent routes OpenAI prompt caching on its session id, end to end.
 *
 * With `cacheConfig: {}` and a `SessionManager` attached, every request the agent sends carries
 * `prompt_cache_key = strands-<sessionId>` — derived automatically, no key management. These tests
 * drive the full path (Agent.invoke -> event loop -> model.stream -> request build) against the real
 * OpenAI API for both the Chat Completions and Responses surfaces, and confirm OpenAI both accepts the
 * derived key and returns a cache read on the repeat turn.
 *
 * The outbound key is captured with a pass-through `fetch` on the OpenAI client: it records the
 * request's `prompt_cache_key` and then performs the genuine network call, so nothing is stubbed.
 */
import { describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { Agent } from '$/sdk/agent/agent.js'
import { SessionManager } from '$/sdk/session/session-manager.js'
import { InMemoryStorage } from '$/sdk/storage/in-memory-storage.js'
import type { OpenAIModel } from '$/sdk/models/openai/index.js'

import { openai, openaiResponses } from '../../__fixtures__/model-providers.js'

// Automatic prompt caching is available on gpt-4o-mini for prefixes past ~1024 tokens.
const MODEL_ID = 'gpt-4o-mini'
const SESSION_ID = 'integ-openai-session-cache'
const DERIVED_KEY = `strands-${SESSION_ID}`
const RESTORE_SESSION_ID = 'integ-openai-session-restore'
const RESTORE_DERIVED_KEY = `strands-${RESTORE_SESSION_ID}`

// A shared system-prompt prefix long enough to clear OpenAI's minimum cacheable length.
const DURABLE_SYSTEM_PREFIX = 'You answer arithmetic questions with only the number and never add commentary. '.repeat(
  200
)

/** A `fetch` that records each outbound `prompt_cache_key`, then performs the real network call. */
function makeSpyFetch(captured: (string | undefined)[]): typeof globalThis.fetch {
  return async (input, init) => {
    let bodyText: string | undefined
    if (typeof init?.body === 'string') {
      bodyText = init.body
    } else if (input instanceof globalThis.Request) {
      bodyText = await input.clone().text()
    }
    if (bodyText) {
      const body = JSON.parse(bodyText) as { prompt_cache_key?: string }
      captured.push(body.prompt_cache_key)
    }
    return globalThis.fetch(input, init)
  }
}

async function assertDerivesAndReusesKey(model: OpenAIModel, captured: (string | undefined)[]): Promise<void> {
  const sessionManager = new SessionManager({ sessionId: SESSION_ID, storage: new InMemoryStorage() })
  // A per-run nonce makes turn 1 a guaranteed cold write, so turn 2's read is caused by this run.
  const systemPrompt = `Session ${uuidv7()}. ${DURABLE_SYSTEM_PREFIX}`
  const agent = new Agent({ model, systemPrompt, sessionManager, printer: false })

  await agent.invoke('What is 2+2? Answer with just the number.')
  const result = await agent.invoke('What is 3+3? Answer with just the number.')

  expect(captured.length).toBeGreaterThanOrEqual(2)
  expect(captured.every((key) => key === DERIVED_KEY)).toBe(true)
  expect(result.metrics?.accumulatedUsage.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
}

async function assertOptsOut(model: OpenAIModel, captured: (string | undefined)[]): Promise<void> {
  const sessionManager = new SessionManager({ sessionId: SESSION_ID, storage: new InMemoryStorage() })
  const agent = new Agent({ model, systemPrompt: 'Answer with just the number.', sessionManager, printer: false })

  await agent.invoke('What is 1+1? Answer with just the number.')

  expect(captured.length).toBeGreaterThan(0)
  expect(captured.every((key) => key === undefined)).toBe(true)
}

async function assertRestoredSessionReusesKey(
  makeModel: () => OpenAIModel,
  captured: (string | undefined)[]
): Promise<void> {
  // Shared storage stands in for the persisted session across a restart.
  const storage = new InMemoryStorage()
  // One nonce shared by both lifetimes: identical prefix so restore can hit, unique per run so the read is ours.
  const systemPrompt = `Restore ${uuidv7()}. ${DURABLE_SYSTEM_PREFIX}`

  const agentBefore = new Agent({
    model: makeModel(),
    systemPrompt,
    sessionManager: new SessionManager({ sessionId: RESTORE_SESSION_ID, storage }),
    printer: false,
  })
  await agentBefore.invoke('What is 2+2? Answer with just the number.')
  await agentBefore.invoke('What is 3+3? Answer with just the number.')

  // Simulate a restart: a brand-new model and agent restore from the same storage.
  const agentAfter = new Agent({
    model: makeModel(),
    systemPrompt,
    sessionManager: new SessionManager({ sessionId: RESTORE_SESSION_ID, storage }),
    printer: false,
  })
  await agentAfter.initialize()
  expect(agentAfter.messages.length).toBeGreaterThan(0) // the session manager rehydrated the prior turns

  const result = await agentAfter.invoke('What is 5+5? Answer with just the number.')

  expect(captured.length).toBeGreaterThanOrEqual(3)
  expect(captured.every((key) => key === RESTORE_DERIVED_KEY)).toBe(true)
  expect(result.metrics?.accumulatedUsage.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
}

describe.skipIf(openai.skip)('OpenAIModel (chat) session prompt cache key', () => {
  it('derives and reuses strands-<sessionId> across turns', async () => {
    const captured: (string | undefined)[] = []
    const model = openai.createModel({
      modelId: MODEL_ID,
      cacheConfig: {},
      clientConfig: { fetch: makeSpyFetch(captured) },
    })
    await assertDerivesAndReusesKey(model, captured)
  })

  it('sends no key when cacheKey is empty', async () => {
    const captured: (string | undefined)[] = []
    const model = openai.createModel({
      modelId: MODEL_ID,
      cacheConfig: { cacheKey: '' },
      clientConfig: { fetch: makeSpyFetch(captured) },
    })
    await assertOptsOut(model, captured)
  })

  it('restores the session and reuses strands-<sessionId> across a restart', async () => {
    const captured: (string | undefined)[] = []
    const spyFetch = makeSpyFetch(captured)
    const makeModel = () =>
      openai.createModel({ modelId: MODEL_ID, cacheConfig: {}, clientConfig: { fetch: spyFetch } })
    await assertRestoredSessionReusesKey(makeModel, captured)
  })
})

describe.skipIf(openaiResponses.skip)('OpenAIModel (responses) session prompt cache key', () => {
  it('derives and reuses strands-<sessionId> across turns', async () => {
    const captured: (string | undefined)[] = []
    const model = openaiResponses.createModel({
      modelId: MODEL_ID,
      cacheConfig: {},
      clientConfig: { fetch: makeSpyFetch(captured) },
    })
    await assertDerivesAndReusesKey(model, captured)
  })

  it('sends no key when cacheKey is empty', async () => {
    const captured: (string | undefined)[] = []
    const model = openaiResponses.createModel({
      modelId: MODEL_ID,
      cacheConfig: { cacheKey: '' },
      clientConfig: { fetch: makeSpyFetch(captured) },
    })
    await assertOptsOut(model, captured)
  })

  it('restores the session and reuses strands-<sessionId> across a restart', async () => {
    const captured: (string | undefined)[] = []
    const spyFetch = makeSpyFetch(captured)
    const makeModel = () =>
      openaiResponses.createModel({ modelId: MODEL_ID, cacheConfig: {}, clientConfig: { fetch: spyFetch } })
    await assertRestoredSessionReusesKey(makeModel, captured)
  })
})
