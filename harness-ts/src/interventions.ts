/**
 * Resolve the harness's `interventions` sugar into SDK intervention handlers.
 *
 * The harness's `interventions` option accepts a preset name, a natural-language policy, a Cedar policy
 * file, an SDK handler instance, or a list of these, and coerces them into the handlers that
 * `Agent({ interventions })` expects. A raw handler instance passes through untouched, so anything
 * the presets don't cover (a Slack `ask` callback, a Cedar principal resolver, custom trust rules)
 * stays reachable by constructing the SDK handler yourself.
 *
 * The string grammar is deterministic — no content sniffing:
 *
 * - a preset keyword (`off`/`ask`/`smart`) maps to a `HumanInTheLoop` config,
 * - a path ending in `.cedar` loads a `CedarAuthorization` policy,
 * - any other string is a natural-language risk policy: it becomes the LLM risk classifier's prompt.
 *
 * Inline Cedar policy text is intentionally *not* auto-detected — it is indistinguishable from
 * prose, so pass `new CedarAuthorization({ policies })` directly for that. Cedar is imported on
 * demand (it needs `@cedar-policy/cedar-wasm`), which is why resolution is async.
 */

import { InterventionHandler } from '@strands-agents/sdk'
import { HumanInTheLoop, type HumanInTheLoopConfig } from '@strands-agents/sdk/vended-interventions/hitl'

/** How a preset collects approval: the SDK's `'stdio'`, a custom async callback, or interrupt/resume. */
export type InterventionAsk = HumanInTheLoopConfig['ask']

export type InterventionValue = string | InterventionHandler
export type InterventionsOption = InterventionValue | InterventionValue[]

async function cedarHandler(policies: string): Promise<InterventionHandler> {
  let mod
  try {
    mod = await import('@strands-agents/sdk/vended-interventions/cedar')
  } catch {
    throw new Error(
      `Cedar policy '${policies}' needs the optional '@cedar-policy/cedar-wasm' dependency; ` +
        'install it to use Cedar interventions.'
    )
  }
  return new mod.CedarAuthorization({ policies })
}

async function resolveOne(value: InterventionValue, ask: InterventionAsk): Promise<InterventionHandler | null> {
  if (value instanceof InterventionHandler) {
    return value
  }
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid interventions value ${JSON.stringify(value)}; expected a preset name, a policy string, or a handler instance.`
    )
  }
  const askOpt = ask ? { ask } : {}
  switch (value.trim()) {
    case 'off':
      return null
    case 'ask':
      return new HumanInTheLoop({ ...askOpt })
    case 'smart':
      return new HumanInTheLoop({ classifier: true, ...askOpt })
  }
  // `.cedar` suffix only: the SDK loader treats a non-`.cedar` string as inline policy, and
  // sniffing file existence would misroute a prose policy that happened to match a filename.
  if (value.trim().endsWith('.cedar')) {
    return cedarHandler(value.trim())
  }
  // Natural-language policy: the LLM risk classifier judges each call against this prompt and
  // escalates a flagged one for approval — like `smart`, but with your own rubric.
  return new HumanInTheLoop({ classifier: { systemPrompt: value }, ...askOpt })
}

/**
 * Raise if two handlers share a name — the SDK registers at most one per `name`, so a second would
 * silently win or be dropped. Different kinds (a Cedar policy plus one human-approval preset) have
 * different names and coexist; two of the same kind collide.
 */
function checkHandlerCollisions(handlers: readonly InterventionHandler[]): void {
  const seen = new Set<string>()
  for (const handler of handlers) {
    if (seen.has(handler.name)) {
      throw new Error(
        `Two interventions share the handler name '${handler.name}', but an agent registers at most ` +
          'one per name. Layer different kinds (e.g. a Cedar policy plus one human-approval preset), ' +
          'not two of the same kind.'
      )
    }
    seen.add(handler.name)
  }
}

/** Coerce the `interventions` sugar into SDK handlers. `undefined`/`'off'` yield `[]`. */
export async function resolveInterventions(
  value: InterventionsOption | undefined,
  options: { ask?: InterventionAsk } = {}
): Promise<InterventionHandler[]> {
  if (value === undefined) {
    return []
  }
  const values = Array.isArray(value) ? value : [value]
  const handlers: InterventionHandler[] = []
  for (const v of values) {
    const handler = await resolveOne(v, options.ask)
    if (handler !== null) {
      handlers.push(handler)
    }
  }
  checkHandlerCollisions(handlers)
  return handlers
}
