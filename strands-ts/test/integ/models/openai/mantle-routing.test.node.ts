/**
 * Drift detection for the hand-maintained Mantle base-path table (#3654).
 *
 * Mantle serves each model from exactly one base path (`/v1` or `/openai/v1`), rejects
 * the other with HTTP 400, and exposes no API that reports the routing, so
 * `OPENAI_PATH_MODEL_PREFIXES` in `mantle.ts` goes stale whenever Mantle onboards a model.
 * For every model in the live catalog, this test asserts that the resolved path serves
 * it, probing the other path only on failure to distinguish misrouted from unserved ids.
 * Only HTTP 200 and 400 count as answers. A misrouted or unserved model fails the test;
 * a model that never settles on 200/400 after retries is inconclusive (transient
 * throttling, or an unentitled model) and skips the test rather than holding the gate.
 *
 * Failure means the table needs updating, not that the SDK is broken for existing models.
 */

import { describe, expect, it } from 'vitest'
import { resolveMantleBasePath, createMantleApiKeySetter } from '$/sdk/models/openai/mantle.js'

import { bedrock } from '../../__fixtures__/model-providers.js'

const REGION = 'us-east-1'
const BASE = `https://bedrock-mantle.${REGION}.api.aws`
const TIMEOUT_MS = 30_000

// Statuses that answer "does this route serve this model": 200 yes, 400 no. Everything
// else is inconclusive and must not be read as "no".
const DEFINITIVE = [200, 400]
const ATTEMPTS = 3

// Cap the catalog sweep so it does not flood Mantle with one request per model at once,
// which draws transient 429s that leave models undetermined. Mirrors the Python test's
// _MAX_WORKERS.
const MAX_WORKERS = 8

// Models that answer on neither OpenAI-compatible base path. The Anthropic family is served
// from /anthropic/v1/messages (a different protocol, reached via AnthropicModel, not
// OpenAIModel), so it is out of scope for this table.
const NOT_OPENAI_COMPATIBLE_PREFIXES = ['anthropic.']

const mintToken = createMantleApiKeySetter({ region: REGION }, REGION)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `worker` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  worker: (item: Item) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await worker(items[index]!)
    }
  })
  await Promise.all(runners)
  return results
}

/** POST to a Mantle route and return the HTTP status (0 on timeout or transport error). */
async function status(path: string, body: unknown, token: string): Promise<number> {
  try {
    const response = await globalThis.fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return response.status
  } catch {
    // Transport failure is undetermined, not "not served".
    return 0
  }
}

/** `status` retried with backoff until it answers 200/400, or the last status seen. */
async function statusSettled(path: string, body: unknown, token: string): Promise<number> {
  let latest = 0
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    latest = await status(path, body, token)
    if (DEFINITIVE.includes(latest)) return latest
    if (attempt < ATTEMPTS - 1) {
      await sleep(2 ** attempt * 1000)
    }
  }
  return latest
}

/**
 * Whether Mantle serves `modelId` from `basePath`.
 *
 * Returns `true` if either API surface answers 200, `false` only if both definitively
 * reject with 400, and `null` when a surface never settled (the route could not be
 * determined and the caller must not treat that as "not served").
 */
async function serves(basePath: string, modelId: string, token: string): Promise<boolean | null> {
  const surfaces: [string, unknown][] = [
    ['chat/completions', { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 8 }],
    ['responses', { model: modelId, input: 'hi', max_output_tokens: 24 }],
  ]

  let determined = true
  for (const [surface, body] of surfaces) {
    const settled = await statusSettled(`${basePath}/${surface}`, body, token)
    if (settled === 200) return true
    if (settled !== 400) determined = false
  }
  return determined ? false : null
}

/**
 * List the live Mantle catalog, or `null` when the account lacks
 * `bedrock-mantle:ListModels`. Locally that skips the tests; in CI it fails so the drift
 * detector cannot silently switch off.
 */
async function listModels(token: string): Promise<string[] | null> {
  const response = await globalThis.fetch(`${BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    if (globalThis.process?.env?.CI === 'true' || globalThis.process?.env?.GITHUB_ACTIONS === 'true') {
      throw new Error(`account lacks bedrock-mantle:ListModels (${response.status})`)
    }
    return null
  }
  if (!response.ok) {
    throw new Error(`GET /v1/models failed with HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as { data?: { id: string }[] }
  if (!payload.data) {
    throw new Error(`GET /v1/models returned no 'data' array: ${JSON.stringify(payload)}`)
  }
  return payload.data.map((m) => m.id).sort()
}

describe.skipIf(bedrock.skip)('Bedrock Mantle base-path routing', () => {
  it(
    'routes every live Mantle model to the base path it is actually served from',
    { timeout: 600_000 },
    async (ctx) => {
      const catalog = await listModels(await mintToken())
      if (catalog === null) {
        ctx.skip('account lacks bedrock-mantle:ListModels')
        return
      }

      const models = catalog.filter((id) => !NOT_OPENAI_COMPATIBLE_PREFIXES.some((prefix) => id.startsWith(prefix)))
      expect(models.length).toBeGreaterThan(0)

      // The resolved path is probed first, so a model served from both paths is ok. Minting
      // per model keeps long sweeps inside the token's lifetime.
      const outcomes = await mapWithConcurrency(models, MAX_WORKERS, async (modelId) => {
        const resolved = resolveMantleBasePath(modelId)
        const other = resolved === '/v1' ? '/openai/v1' : '/v1'

        const onResolved = await serves(resolved, modelId, await mintToken())
        if (onResolved === true) return { modelId, verdict: 'ok' as const, resolved }

        const onOther = await serves(other, modelId, await mintToken())
        if (onOther === true) return { modelId, verdict: 'misrouted' as const, resolved }
        if (onResolved === null || onOther === null) return { modelId, verdict: 'undetermined' as const, resolved }
        return { modelId, verdict: 'unserved' as const, resolved }
      })

      const ids = (verdict: string): Record<string, string> =>
        Object.fromEntries(
          outcomes
            .filter((outcome) => outcome.verdict === verdict)
            .map((outcome) => [outcome.modelId, outcome.resolved])
        )

      expect(
        ids('misrouted'),
        'Mantle serves these models from the base path the SDK does not use. Update ' +
          'OPENAI_PATH_MODEL_PREFIXES in strands-ts/src/models/openai/mantle.ts (and the Python ' +
          'mirror in strands-py/src/strands/models/_openai_bedrock.py)'
      ).toEqual({})

      expect(
        ids('unserved'),
        'Mantle lists these models but serves them from neither OpenAI-compatible base path, ' +
          'so OpenAIModel cannot reach them at all. They likely speak another protocol (as ' +
          'anthropic.* does via /anthropic/v1/messages) and need adding to ' +
          'NOT_OPENAI_COMPATIBLE_PREFIXES'
      ).toEqual({})

      // Undetermined means Mantle never returned a definitive 200/400 (transient 429/5xx/timeout,
      // or a model the account is not entitled to). That is not routing drift, so skip rather than
      // hold the gate on an inconclusive external-service sweep. misrouted/unserved are checked
      // first so an inconclusive probe cannot read as a clean sweep.
      const undetermined = ids('undetermined')
      if (Object.keys(undetermined).length > 0) {
        console.warn(`mantle routing could not be verified for: ${JSON.stringify(undetermined)}`)
        ctx.skip()
      }
    }
  )
})
