/**
 * Model routing primitives.
 *
 * A {@link ModelRouter} asks its {@link RoutingStrategy} before the first model call and after
 * unclaimed failures until routing stops. Returning `undefined` from the opening selection uses the
 * first candidate's concrete default model; returning it after a failure preserves the pending error.
 *
 * A failure round uses each candidate at most once. A successful call starts a new round with that
 * candidate already counted as used. Nested routers are opaque candidates: they make one selection
 * with an empty attempt history and do not perform internal failover for the outer router.
 *
 * `agent.model` remains the first candidate's concrete model. Opening selection runs in model input
 * middleware after continuation input is incorporated, so the opening before-model hook reports that
 * default while {@link AfterModelCallEvent} reports the effective routed model. Token estimation also
 * uses the default model, so prefer candidates with comparable context windows and tokenizers. If a
 * candidate fails after emitting part of a streamed response, consumers see that partial output
 * followed by the replacement model's full response.
 *
 * The API is provisional and may change before it is finalized.
 */
import { CancelledError, JsonValidationError, normalizeError } from '../../errors.js'
import { AfterInvocationEvent, AfterModelCallEvent, BeforeInvocationEvent } from '../../hooks/events.js'
import { HookOrder } from '../../hooks/types.js'
import { logger } from '../../logging/logger.js'
import { InvokeModelStage } from '../../middleware/stages.js'
import { Model } from '../model.js'
import { cloneSystemPrompt, type Message, type SystemPrompt } from '../../types/messages.js'
import { deepCopy, deepCopyWithValidation, type JSONValue } from '../../types/json.js'
import type { InvokeModelContext } from '../../middleware/stages.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { ToolSpec } from '../../tools/types.js'
import type { InvocationState, LocalAgent } from '../../types/agent.js'
import { FallbackStrategy } from './fallback-strategy.js'
import type { CandidateInput, RoutingAttempt, RoutingContext, RoutingStrategy } from './strategy.js'

/** Construction data for a {@link RoutingCandidate}. */
export interface RoutingCandidateOptions {
  /** Concrete model or opaque nested router. */
  readonly model: Model | ModelRouter
  /** Optional strategy-facing name. */
  readonly name?: string
  /** Optional strategy-facing description. */
  readonly description?: string
  /** Optional strategy-facing evidence; must be JSON-serializable and free of secrets. */
  readonly metadata?: Readonly<Record<string, JSONValue>>
}

/**
 * A model or opaque model group with optional strategy-facing evidence.
 *
 * Classifier-based strategies may send `name`, `description`, and `metadata` across provider
 * boundaries, so they must not contain secrets. Metadata is stored without copying, so it must not
 * be mutated after construction.
 *
 * Base instances are frozen automatically. Subclasses must freeze themselves after initializing additional fields.
 */
export class RoutingCandidate {
  /** Concrete model or opaque nested router. */
  readonly model: Model | ModelRouter
  /** Optional strategy-facing name. */
  readonly name?: string
  /** Optional strategy-facing description. */
  readonly description?: string
  /** Optional strategy-facing evidence; must be JSON-serializable and free of secrets. */
  readonly metadata?: Readonly<Record<string, JSONValue>>

  /**
   * Create an immutable routing candidate.
   *
   * @param options - Candidate model, name, description, and metadata
   * @throws TypeError if metadata is not a plain object
   * @throws JsonValidationError if metadata contains values that cannot be serialized to JSON
   * @throws Error if metadata serialization fails for another reason
   */
  constructor(options: RoutingCandidateOptions) {
    this.model = options.model
    if (options.name !== undefined) this.name = options.name
    if (options.description !== undefined) this.description = options.description
    if (options.metadata !== undefined) this.metadata = validatedMetadata(options.metadata)
    if (new.target === RoutingCandidate) Object.freeze(this)
  }
}

/** Options for constructing a {@link ModelRouter}. */
export interface ModelRouterOptions {
  /** Strategy responsible for every routing decision. */
  readonly strategy?: RoutingStrategy
  /** Maximum successful candidate switches per invocation. */
  readonly maxSwitches?: number
}

/** Per-invocation candidate, attempt history, and switch accounting. */
class RoutingState {
  candidate: RoutingCandidate
  model: Model
  readonly attempts: RoutingAttempt[] = []
  switchedTo: Set<RoutingCandidate>
  switches = 0

  constructor(candidate: RoutingCandidate, model: Model) {
    this.candidate = candidate
    this.model = model
    // The opening candidate counts as used for this round.
    this.switchedTo = new Set([candidate])
  }
}

const ROUTING_KEY_PREFIX = 'strands:modelRouting'

/** Lazily minted per-object identity numbers (the `id()` equivalent for state keys), weakly held. */
const OBJECT_IDS = new WeakMap<object, number>()
let nextObjectId = 1

/**
 * Routes each agent invocation among an immutable set of candidate models.
 *
 * The default {@link FallbackStrategy} prefers the candidate with the fewest recorded failures and
 * breaks ties by declaration order. `maxSwitches` bounds successful candidate changes per invocation.
 *
 * @example
 * ```typescript
 * const router = new ModelRouter([
 *   new RoutingCandidate({ model: primary, name: 'primary' }),
 *   new RoutingCandidate({ model: fallback, name: 'fallback' }),
 * ])
 * const agent = new Agent({ model: router })
 * ```
 */
export class ModelRouter implements Plugin {
  readonly name = 'strands:model-router'
  private readonly _candidates: readonly RoutingCandidate[]
  private readonly _strategy: RoutingStrategy
  private readonly _maxSwitches?: number
  private readonly _attachedAgents = new WeakSet<LocalAgent>()
  private readonly _initializedAgents = new WeakSet<LocalAgent>()

  /**
   * Create a model router.
   *
   * @param models - Candidate models, nested routers, or candidate wrappers
   * @param options - Routing strategy and switch cap
   * @throws TypeError if models or the strategy are invalid
   * @throws Error if candidates are empty, duplicated, named alike, stateful, or `maxSwitches` is not a non-negative integer
   */
  constructor(models: readonly CandidateInput[], options: ModelRouterOptions = {}) {
    if (options.strategy !== undefined && !isRoutingStrategy(options.strategy)) {
      throw new TypeError('strategy must implement RoutingStrategy: a select(context) method')
    }
    if (options.maxSwitches !== undefined && (!Number.isInteger(options.maxSwitches) || options.maxSwitches < 0)) {
      throw new Error('maxSwitches must be a non-negative integer')
    }

    const candidates = normalize(models)
    if (candidates.length === 0) throw new Error('ModelRouter requires at least one candidate model')
    rejectStateful(candidates)
    rejectDuplicates(candidates)

    this._candidates = Object.freeze(candidates)
    this._strategy = options.strategy ?? new FallbackStrategy()
    if (options.maxSwitches !== undefined) this._maxSwitches = options.maxSwitches
  }

  /** Normalized candidates in declaration order. */
  get candidates(): readonly RoutingCandidate[] {
    return this._candidates
  }

  /** First declared candidate resolved without consulting a strategy. */
  get defaultModel(): Model {
    const model = this._candidates[0]!.model
    return model instanceof ModelRouter ? model.defaultModel : model
  }

  /**
   * Attach this router as an agent's configured model.
   *
   * @internal
   * @param agent - Agent configured with this router
   */
  attachToAgent(agent: LocalAgent): void {
    this._attachedAgents.add(agent)
    this.initAgent(agent)
  }

  /**
   * Register routing middleware and lifecycle hooks.
   *
   * @param agent - Agent using this router as its model
   * @throws Error if attached as an ordinary plugin rather than as the model
   */
  initAgent(agent: LocalAgent): void {
    if (!this._attachedAgents.has(agent)) {
      throw new Error('ModelRouter must be passed through Agent({ model }), not plugins')
    }
    if (this._initializedAgents.has(agent)) return
    this._initializedAgents.add(agent)

    agent.addMiddleware(InvokeModelStage.Input, (context) => this._selectionMiddleware(context))
    agent.addHook(AfterModelCallEvent, (event) => this._onModelResult(event), { order: HookOrder.MODEL_ROUTING })
    agent.addHook(AfterInvocationEvent, (event) => this._clearState(event.agent, event.invocationState), {
      order: HookOrder.SDK_LAST,
    })
    agent.addHook(BeforeInvocationEvent, (event) => this._clearState(event.agent, event.invocationState), {
      order: HookOrder.SDK_FIRST,
    })
  }

  /**
   * Return the current routed model after hooks may have changed the selection.
   *
   * @internal
   * @param agent - Agent making the model call
   * @param invocationState - Live invocation state
   * @returns Current routed model, or `undefined` before selection
   */
  getRoutedModel(agent: LocalAgent, invocationState: InvocationState): Model | undefined {
    return this._getState(agent, invocationState)?.model
  }

  /** Apply the per-invocation selection to the model call, opening one on the first call. */
  private async _selectionMiddleware(context: InvokeModelContext): Promise<InvokeModelContext> {
    let state = this._getState(context.agent, context.invocationState)
    if (state === undefined) {
      const routingContext = this._routingContext(
        [...context.messages],
        context.systemPrompt,
        [...context.toolSpecs],
        context.invocationState
      )
      state = await this._openAndCache(context.agent, context.invocationState, routingContext)
    }
    return { ...context, model: state.model } as InvokeModelContext
  }

  /** Make the opening choice and store its state in the invocation state under this pair's key. */
  private async _openAndCache(
    agent: LocalAgent,
    invocationState: InvocationState,
    context: RoutingContext
  ): Promise<RoutingState> {
    const [candidate, model] = await this._open(context)
    const state = new RoutingState(candidate, model)
    invocationState[this._stateKey(agent)] = state
    return state
  }

  /**
   * Choose and resolve the candidate to start on.
   *
   * A decline serves the default model. A strategy that throws, and a candidate that will not resolve
   * to a model, both propagate.
   */
  private async _open(context: RoutingContext): Promise<readonly [RoutingCandidate, Model]> {
    const candidate = await this._ask(context)
    if (candidate === undefined) {
      const fallback = this._candidates[0]!
      const model = this.defaultModel
      logger.info(
        `strategy=<${this._strategyName}>, candidate=<${candidateLabel(fallback)}>, model=<${modelLabel(model)}> | strategy declined the opening choice, using the default model`
      )
      return [fallback, model]
    }

    const model = await this._resolve(candidate, context)
    logger.info(
      `strategy=<${this._strategyName}>, candidate=<${candidateLabel(candidate)}>, model=<${modelLabel(model)}> | candidate selected`
    )
    return [candidate, model]
  }

  /** Ask the strategy for a candidate and validate the answer. */
  private async _ask(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    return this._validated(await this._strategy.select(context), context)
  }

  /** Return the candidate, throwing if the strategy broke its contract. */
  private _validated(candidate: unknown, context: RoutingContext): RoutingCandidate | undefined {
    if (candidate === undefined) return undefined
    if (!(candidate instanceof RoutingCandidate)) {
      throw new TypeError(`strategy.select must return a RoutingCandidate or undefined; got ${typeName(candidate)}`)
    }
    if (!context.candidates.some((configured) => configured === candidate)) {
      throw new Error('strategy.select must return a candidate from context.candidates')
    }
    return candidate
  }

  /**
   * Resolve a candidate to a concrete model, recursing into a nested router's selection.
   *
   * A nested router is asked with its own candidates and no attempts, so it contributes one candidate
   * and never advances internally.
   */
  private async _resolve(candidate: RoutingCandidate, context: RoutingContext): Promise<Model> {
    if (!(candidate.model instanceof ModelRouter)) return candidate.model
    return candidate.model._selectModel(
      candidate.model._routingContext(
        context.messages,
        context.systemPrompt,
        context.toolSpecs,
        context.invocationState,
        []
      )
    )
  }

  /** Resolve this router's chosen candidate, or its default model if the strategy declines. */
  private async _selectModel(context: RoutingContext): Promise<Model> {
    const candidate = await this._ask(context)
    if (candidate === undefined) return this.defaultModel
    return this._resolve(candidate, context)
  }

  /** Strategy class name, for logs that explain a routing decision. */
  private get _strategyName(): string {
    return this._strategy.constructor.name
  }

  /** Record the outcome and, after an unclaimed failure, apply the strategy's next choice. */
  private async _onModelResult(event: AfterModelCallEvent): Promise<void> {
    const state = this._getState(event.agent, event.invocationState)
    if (state === undefined) return

    if (event.error instanceof CancelledError) return
    if (event.stopData !== undefined) {
      state.attempts.push(makeAttempt(state.candidate))
      // The candidate that succeeded opens the next round, counting as used like any opening choice.
      state.switchedTo = new Set([state.candidate])
      return
    }
    if (event.retry || event.error === undefined) return

    state.attempts.push(makeAttempt(state.candidate, event.error))
    if (this._maxSwitches !== undefined && state.switches >= this._maxSwitches) {
      logger.warn(`maxSwitches=<${this._maxSwitches}> | switch cap reached, leaving the error to surface`)
      return
    }

    if (await this._advance(event, state)) event.retry = true
  }

  /**
   * Switch to the strategy's next candidate, returning whether the call should be retried.
   *
   * A usable new candidate is switched to. A strategy that throws, declines, or names a candidate the
   * round already used leaves the model's error to surface. A candidate that will not resolve is
   * unusable rather than unlucky, so it takes its slot in the round and the strategy is asked once
   * more. Each pass either switches or consumes a slot, so the round stays bounded by the candidate
   * count.
   */
  private async _advance(event: AfterModelCallEvent, state: RoutingState): Promise<boolean> {
    while (true) {
      const context = this._routingContext(
        event.agent.messages,
        event.agent.systemPrompt,
        event.agent.toolRegistry.list().map((tool) => tool.toolSpec),
        event.invocationState,
        state.attempts
      )

      let candidate: RoutingCandidate | undefined
      try {
        // Validated inside the try: a model error is already pending, so a broken answer must not
        // replace it. The opening choice has nothing pending and lets the error surface.
        candidate = this._validated(await this._strategy.select(context), context)
      } catch (error) {
        logger.warn(
          `strategy=<${this._strategyName}>, error=<${String(error)}> | routing failed, leaving the error to surface`
        )
        return false
      }
      if (candidate === undefined) return false
      // A round uses each candidate at most once, so a strategy that cycles cannot keep resetting
      // the retry budget.
      if (state.switchedTo.has(candidate)) {
        logger.info(`candidate=<${candidateLabel(candidate)}> | already used this round, leaving the error to surface`)
        return false
      }

      let model: Model
      try {
        model = await this._resolve(candidate, context)
      } catch (error) {
        const resolutionError = normalizeError(error)
        logger.warn(
          `candidate=<${candidateLabel(candidate)}>, error=<${resolutionError}> | candidate could not be resolved, asking again`
        )
        // Recorded so a strategy reading attempts stops offering it, and slot-burned so termination
        // does not depend on the strategy doing that.
        state.attempts.push(makeAttempt(candidate, resolutionError))
        state.switchedTo.add(candidate)
        continue
      }

      logger.info(
        `from_candidate=<${candidateLabel(state.candidate)}>, to_candidate=<${candidateLabel(candidate)}>, error=<${event.error?.constructor.name}> | model call failed, switching candidate`
      )
      state.candidate = candidate
      state.model = model
      state.switchedTo.add(candidate)
      state.switches += 1
      return true
    }
  }

  /**
   * Build a {@link RoutingContext} over this router's candidates.
   *
   * Every ask goes through here, so the request a strategy sees is always a copy: the agent's messages
   * and the registry's own tool specs are never handed over directly. Mirrors the copy the agent loop
   * makes for each model call.
   */
  private _routingContext(
    messages: readonly Message[],
    systemPrompt: SystemPrompt | undefined,
    toolSpecs: readonly ToolSpec[],
    invocationState: InvocationState,
    attempts: readonly RoutingAttempt[] = []
  ): RoutingContext {
    const context: RoutingContext = {
      messages: messages.map((message) => message.clone()),
      ...(systemPrompt !== undefined && { systemPrompt: cloneSystemPrompt(systemPrompt) }),
      toolSpecs: deepCopy(toolSpecs) as unknown as ToolSpec[],
      candidates: this._candidates,
      invocationState,
      attempts: Object.freeze([...attempts]),
    }
    return Object.freeze(context)
  }

  /** Drop this agent's routing state so it never spans invocations. */
  private _clearState(agent: LocalAgent, invocationState: InvocationState): void {
    const key = this._stateKey(agent)
    if (this._getState(agent, invocationState) !== undefined) delete invocationState[key]
  }

  /** Return the routing state stored under this pair's key, ignoring any foreign value. */
  private _getState(agent: LocalAgent, invocationState: InvocationState): RoutingState | undefined {
    const value = invocationState[this._stateKey(agent)]
    return value instanceof RoutingState ? value : undefined
  }

  /**
   * Scope routing state to one agent/router pair.
   *
   * One invocation state can serve several agents, and one router several agents, so neither identity
   * alone is a sufficient key. `agentId` cannot serve either: it is caller-supplied and defaults, so
   * two agents sharing a router could collide. Object identity is unique among live agents, and the
   * state is cleared at both ends of an invocation, so a recycled entry cannot match a live one.
   *
   * The key carries no per-invocation component, so isolation between concurrent invocations relies on
   * the agent allowing only one at a time, which is its default.
   */
  private _stateKey(agent: LocalAgent): string {
    return `${ROUTING_KEY_PREFIX}:${objectId(agent).toString(16)}:${objectId(this).toString(16)}`
  }
}

/** Freeze a routing attempt, omitting `exception` for a success. */
function makeAttempt(candidate: RoutingCandidate, exception?: Error): RoutingAttempt {
  return Object.freeze({ candidate, ...(exception !== undefined && { exception }) })
}

/** Return a stable identity number for the object, minting one on first use. */
function objectId(value: object): number {
  let identity = OBJECT_IDS.get(value)
  if (identity === undefined) {
    identity = nextObjectId
    nextObjectId += 1
    OBJECT_IDS.set(value, identity)
  }
  return identity
}

/** Coerce the input array into {@link RoutingCandidate} objects, validating candidate types. */
function normalize(models: unknown): RoutingCandidate[] {
  if (!Array.isArray(models)) throw new TypeError('models must be a sequence of candidates')
  return models.map(asCandidate)
}

/** Wrap a candidate input in a {@link RoutingCandidate}, validating its model type. */
function asCandidate(item: unknown): RoutingCandidate {
  const candidate = item instanceof RoutingCandidate ? item : new RoutingCandidate({ model: item as Model })
  if (!(candidate.model instanceof Model) && !(candidate.model instanceof ModelRouter)) {
    throw new TypeError(`candidate must be a Model or ModelRouter; got ${typeName(candidate.model)}`)
  }
  return candidate
}

/** Return caller-owned metadata after validating that it is a JSON-serializable object. */
function validatedMetadata(metadata: Readonly<Record<string, JSONValue>>): Readonly<Record<string, JSONValue>> {
  if (!isObject(metadata) || Array.isArray(metadata)) throw new TypeError('metadata must be an object')
  try {
    deepCopyWithValidation(metadata, 'metadata')
  } catch (error) {
    if (error instanceof JsonValidationError) throw error
    throw new Error(`metadata must be JSON-serializable: ${normalizeError(error).message}`, { cause: error })
  }
  // JSON.stringify silently serializes non-finite numbers as null rather than failing.
  JSON.stringify(metadata, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new JsonValidationError('metadata contains a non-finite number which cannot be serialized')
    }
    return value
  })
  return metadata
}

/** Reject any stateful candidate model. */
function rejectStateful(candidates: readonly RoutingCandidate[]): void {
  for (const candidate of candidates) {
    if (candidate.model instanceof Model && candidate.model.stateful) {
      throw new Error(
        `candidate=<${candidateLabel(candidate)}> is stateful; routing among stateful models is not supported`
      )
    }
  }
}

/**
 * Reject repeated candidates, repeated models, or colliding names.
 *
 * Strategies track health per candidate, so one model behind two candidates would get two failure
 * budgets and never be demoted. The model check reaches through a nested router; names stay per level,
 * since a strategy only chooses among the candidates it is shown.
 */
function rejectDuplicates(candidates: readonly RoutingCandidate[]): void {
  const seenCandidates = new Set<RoutingCandidate>()
  const seenModels = new Set<Model>()
  const seenNames = new Set<string>()

  for (const candidate of candidates) {
    if (seenCandidates.has(candidate)) throw new Error('duplicate RoutingCandidate instance')
    seenCandidates.add(candidate)

    for (const model of reachableModels(candidate)) {
      if (seenModels.has(model)) {
        throw new Error(
          `candidate=<${candidateLabel(candidate)}> repeats a model already routed to; construct a separate instance so each candidate has its own health`
        )
      }
      seenModels.add(model)
    }

    if (candidate.name === undefined) continue
    if (seenNames.has(candidate.name)) throw new Error(`duplicate candidate name=<${candidate.name}>`)
    seenNames.add(candidate.name)
  }
}

/** Yield every concrete model this candidate can run, descending into a nested router. */
function* reachableModels(candidate: RoutingCandidate): Generator<Model> {
  if (candidate.model instanceof ModelRouter) {
    for (const nested of candidate.model.candidates) yield* reachableModels(nested)
  } else {
    yield candidate.model
  }
}

/** Return the candidate's name, or its provider and model id when it has none. */
function candidateLabel(candidate: RoutingCandidate): string {
  if (candidate.name !== undefined && candidate.name.length > 0) return candidate.name
  return candidate.model instanceof Model ? modelLabel(candidate.model) : candidate.model.constructor.name
}

/**
 * Label a model by provider and model id.
 *
 * Labels are built eagerly, as log arguments and by the construction guards, so one must never fail a
 * routed call or mask a construction error.
 */
function modelLabel(model: Model): string {
  const provider = model.constructor.name
  try {
    const modelId = model.getConfig()?.modelId
    return modelId ? `${provider}/${modelId}` : provider
  } catch {
    return provider
  }
}

/** Check whether the value structurally implements {@link RoutingStrategy}. */
function isRoutingStrategy(strategy: unknown): strategy is RoutingStrategy {
  return isObject(strategy) && 'select' in strategy && typeof strategy.select === 'function'
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/** Describe a value's type for error messages. */
function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'object') return value.constructor?.name ?? 'object'
  return typeof value
}
