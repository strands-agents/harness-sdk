import { readFileSync, existsSync } from 'node:fs'
import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny } from '../../interventions/actions.js'
import { loadDogwoodModule } from './module.js'
import type { InterventionAction, Proceed } from '../../interventions/actions.js'
import type { BeforeToolCallEvent, AfterToolCallEvent } from '../../hooks/events.js'
import type { OnError } from '../../interventions/handler.js'
import type {
  DogwoodAuthorizerInstance,
  DogwoodEntityInput,
  DogwoodEntityRef,
  DogwoodEventInput,
  DogwoodGroups,
  DogwoodModule,
  DogwoodValue,
} from './module.js'

/** The namespace `mcpToCedarSchema` layers its generated schema on. */
const DEFAULT_NAMESPACE = 'Drupe'

/**
 * Minimal tool definition for schema generation. Matches MCP tool format.
 *
 * @internal Nameable only through {@link DogwoodAuthorizationConfig}.
 */
interface ToolDefinition {
  name: string
  inputSchema?: { type: string; properties?: Record<string, DogwoodValue>; required?: string[] }
  description?: string
}

/**
 * The groups a handler adds to an event, split by which half reads them.
 *
 * @internal Nameable only through {@link DogwoodAuthorizationConfig}.
 */
interface DogwoodEventGroups {
  /** Added to the durable temporal record. */
  logged?: DogwoodGroups
  /** Added to the ephemeral Cedar request context. */
  context?: DogwoodGroups
}

/**
 * Configuration for the {@link DogwoodAuthorization} intervention handler.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood}
 */
export interface DogwoodAuthorizationConfig {
  /** Dogwood policy text, or a path to a `.dw` file on disk. */
  policy: string

  /** Cedar action schema text, or a path to a `.cedarschema` file. Auto-generated from `tools`. */
  actionSchema?: string

  /** Tool definitions (MCP format) for auto schema generation. Use with `DogwoodAuthorization.create()`. */
  tools?: ToolDefinition[]

  /** Event-schema DSL text, or a path to a `.dwschema` file. Omit for the default kinds. */
  eventSchema?: string

  /**
   * Information-provider declarations (`providers.json` text, or a path to one).
   *
   * Rhai providers must be inline scripts — a `scriptFile` reference is rejected,
   * because wasm has no filesystem to resolve it against.
   */
  providers?: string

  /** Macro library text. */
  macros?: string

  /** Cedar namespace for actions, principals, and resources. Defaults to `'Drupe'`. */
  namespace?: string

  /** Static principal. Defaults to `<namespace>::User::"anonymous"`. Mutually exclusive with `principalResolver`. */
  principal?: DogwoodEntityRef

  /**
   * Dynamic principal resolver for multi-tenant agents.
   * Return `undefined` to deny (fail-closed). Mutually exclusive with `principal`.
   */
  principalResolver?: ((invocationState: Record<string, unknown>) => DogwoodEntityRef | undefined) | undefined

  /** Static resource. Defaults to `<namespace>::Gateway::"agent"`. */
  resource?: DogwoodEntityRef

  /**
   * Adds field groups to each event. Both halves default to `{ input: <tool args> }`
   * (and `output` on a response), and the handler's own groups win on conflict.
   *
   * `logged` is the durable temporal record later events correlate against;
   * `context` is the ephemeral Cedar bag read as `context.<group>.<field>`. A
   * group both need must be returned in both. Every group must be declared by
   * the action schema, or evaluation errors and the call fails closed.
   */
  eventEnricher?:
    | ((context: {
        toolName: string
        toolInput: Record<string, unknown>
        invocationState: Record<string, unknown>
      }) => DogwoodEventGroups)
    | undefined

  /** Entities supplied to every decision — attributes and hierarchy a policy reads. */
  entities?: DogwoodEntityInput[]

  /**
   * Record a history-only `response` (or `error`) event after each tool call, so
   * temporal rules keyed on a completed call can fire. Defaults to `true`.
   *
   * Dogwood observes an event into history before deciding it, so a `request`
   * event is its own predecessor and `formerly … request{}` self-satisfies on
   * the first call. Only a separately recorded response flips such a verdict.
   *
   * The recorded event carries the tool input and an empty `output` group, which
   * is all a `formerly … response{}` existence check needs. To log fields of the
   * actual result — for a custom `eventSchema` that declares them — return an
   * `output` group from {@link eventEnricher}.
   */
  recordResponses?: boolean

  /**
   * The loaded `@aws/dogwood-wasm` module. Required by the constructor; omit it
   * and use {@link DogwoodAuthorization.create} to have it imported.
   */
  module?: DogwoodModule

  /** Clock returning epoch SECONDS. Defaults to the system clock. */
  now?: () => number

  /**
   * What to do when this handler throws: `'throw'` (default) rethrows,
   * `'deny'` denies the tool call (fail-closed).
   *
   * **Warning:** `'proceed'` is fail-open — the tool runs with no authorization
   * check. A wasm trap always denies regardless, since the module cannot be trusted.
   */
  onError?: OnError | undefined
}

/**
 * Dogwood authorization intervention handler. Evaluates a `.dw` policy set
 * before each tool call, and records the result afterward so temporal rules work.
 *
 * Each tool maps to: Action = `<namespace>::Action::<tool name>`,
 * Principal = the configured/resolved user, Resource = the gateway,
 * and `input` = the tool arguments in both `logged` and `context`.
 *
 * Holds temporal history, so one instance is one ordered history. History is
 * never pruned (~1.6 KB per event) — use one handler per session or principal
 * and {@link reset} or {@link free} it when the session ends.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood-wasm | dogwood-wasm}
 *
 * @example
 * ```typescript
 * const dogwood = await DogwoodAuthorization.create({
 *   policy: 'permit(principal, action == Drupe::Action::"search", resource);',
 *   tools: [{ name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
 * })
 *
 * const agent = new Agent({ model, tools: [searchTool], interventions: [dogwood] })
 * ```
 */
export class DogwoodAuthorization extends InterventionHandler {
  readonly name = 'dogwood-authorization'
  override readonly onError: OnError

  private readonly _authorizer: DogwoodAuthorizerInstance
  private readonly _principal: DogwoodEntityRef | undefined
  private readonly _principalResolver: DogwoodAuthorizationConfig['principalResolver']
  private readonly _resource: DogwoodEntityRef
  private readonly _eventEnricher: DogwoodAuthorizationConfig['eventEnricher']
  private readonly _entities: DogwoodEntityInput[]
  private readonly _recordResponses: boolean
  private readonly _actionType: string
  private readonly _now: () => number
  private readonly _declaredActions: ReadonlySet<string>
  private readonly _declaredKinds: ReadonlySet<string>

  /**
   * The wasm module is shared process-wide, so a trap poisons every instance.
   * Once set, every later decision denies without calling in again.
   */
  private _poisoned = false

  /**
   * Tool-use ids this handler allowed and has not yet recorded a result for.
   * A call blocked by this handler or any later one must never reach the
   * temporal history, or it could satisfy a `formerly … response{}` rule.
   */
  private readonly _allowedCalls = new Set<string>()

  /**
   * Builds a handler, importing `@aws/dogwood-wasm` and generating the action
   * schema from `tools` when neither is supplied.
   *
   * @param config - Handler configuration.
   * @returns The constructed handler.
   * @throws Error when the module cannot be loaded, or a `DogwoodError` when the
   * policy fails to parse, lower, or type-check.
   */
  static async create(config: DogwoodAuthorizationConfig): Promise<DogwoodAuthorization> {
    const module = config.module ?? (await loadDogwoodModule())
    return new DogwoodAuthorization({ ...config, module })
  }

  constructor(config: DogwoodAuthorizationConfig) {
    super()
    if (config.principal && config.principalResolver) {
      throw new Error('Provide either `principal` or `principalResolver`, not both')
    }
    if (!config.module) {
      throw new Error(
        '`module` is required. Pass the loaded @aws/dogwood-wasm module, or use DogwoodAuthorization.create()'
      )
    }
    if (!config.actionSchema && !config.tools) {
      throw new Error('Provide either `actionSchema` or `tools`')
    }

    const namespace = config.namespace ?? DEFAULT_NAMESPACE
    this._actionType = `${namespace}::Action`
    this._resource = config.resource ?? { type: `${namespace}::Gateway`, id: 'agent' }
    this._principal = config.principalResolver
      ? undefined
      : (config.principal ?? { type: `${namespace}::User`, id: 'anonymous' })
    this._principalResolver = config.principalResolver
    this._eventEnricher = config.eventEnricher
    this._entities = config.entities ?? []
    this._recordResponses = config.recordResponses ?? true
    this._now = config.now ?? (() => Math.floor(Date.now() / 1000))
    this.onError = config.onError ?? 'throw'

    const actionSchema = config.actionSchema
      ? loadSource(config.actionSchema, '.cedarschema')
      : config.module.mcpToCedarSchema(JSON.stringify(config.tools))

    this._authorizer = new config.module.DogwoodAuthorizer(
      loadSource(config.policy, '.dw'),
      actionSchema,
      config.eventSchema ? loadSource(config.eventSchema, '.dwschema') : undefined,
      config.providers ? loadSource(config.providers, '.json') : undefined,
      config.macros
    )

    // Captured once so an unmapped tool or kind is caught without calling into
    // wasm, which rejects both by throwing.
    this._declaredActions = new Set(this._authorizer.actions)
    this._declaredKinds = new Set(this._authorizer.eventKinds)
  }

  override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
    if (this._poisoned) {
      return deny('Dogwood module is unusable after a wasm trap; denying')
    }

    const invocationState = event.invocationState as Record<string, unknown>
    const principal = this._principal ?? this._principalResolver?.(invocationState)
    if (!principal?.type || !principal.id) {
      return deny('No principal identity found in invocation state')
    }

    const toolName = event.toolUse.name
    const action = `${this._actionType}::${toolName}`
    if (!this._declaredActions.has(action)) {
      return deny(`Tool '${toolName}' is not declared by the Dogwood action schema; denying`)
    }

    const toolInput = (event.toolUse.input ?? {}) as Record<string, unknown>
    const enriched = this._eventEnricher?.({ toolName, toolInput, invocationState })
    const input = toolInput as Record<string, DogwoodValue>

    const decision = this._decide({
      action,
      kind: 'request',
      timestamp: this._timestamp(),
      principal,
      resource: this._resource,
      logged: mergeGroups(enriched?.logged, { input }),
      context: mergeGroups(enriched?.context, { input }),
      entities: this._entities,
    })

    if (decision === 'trapped') {
      return deny('Dogwood evaluation trapped the wasm module; denying')
    }
    // A decision kind always yields a verdict; treat an absent one as fail-closed.
    if (!decision) {
      return deny(`No Dogwood decision returned for '${toolName}'; denying`)
    }
    if (decision.allowed) {
      if (this._recordResponses) {
        this._allowedCalls.add(event.toolUse.toolUseId)
      }
      return proceed()
    }
    if (decision.errors.length > 0) {
      return deny(`Dogwood evaluation failed: ${decision.errors.join(', ')}`)
    }
    const rules = decision.determining_rules
    return deny(`Access denied by Dogwood policy${rules.length ? ` (rule ${rules.join(', ')})` : ''}`)
  }

  override afterToolCall(event: AfterToolCallEvent): Proceed {
    // A blocked call still reaches here, so only a call this handler allowed is
    // a candidate for the history.
    if (this._poisoned || !this._allowedCalls.delete(event.toolUse.toolUseId)) {
      return proceed()
    }
    // An error status with no `Error` is the executor's cancellation result: a
    // later handler blocked the call, so the tool never ran.
    if (event.result.status === 'error' && event.error === undefined) {
      return proceed()
    }

    const kind = event.error ? 'error' : 'response'
    const action = `${this._actionType}::${event.toolUse.name}`
    // A custom event schema need not declare either kind, and the tool may not
    // be in the schema at all — both would be rejected, so skip instead.
    if (!this._declaredKinds.has(kind) || !this._declaredActions.has(action)) {
      return proceed()
    }

    const invocationState = event.invocationState as Record<string, unknown>
    const toolInput = (event.toolUse.input ?? {}) as Record<string, unknown>
    const enriched = this._eventEnricher?.({ toolName: event.toolUse.name, toolInput, invocationState })
    const groups = { input: toolInput as Record<string, DogwoodValue>, output: {} }
    const principal = this._principal ?? this._principalResolver?.(invocationState)

    // History-only: returns no verdict, so there is nothing to enforce here.
    this._decide({
      action,
      kind,
      timestamp: this._timestamp(),
      ...(principal !== undefined && { principal }),
      resource: this._resource,
      logged: mergeGroups(enriched?.logged, groups),
      context: mergeGroups(enriched?.context, groups),
      entities: this._entities,
    })

    return proceed()
  }

  /** Drops accumulated temporal history and re-lowers the policy. */
  reset(): void {
    this._authorizer.reset()
  }

  /** Releases the wasm-heap memory the authorizer owns. The handler is unusable afterward. */
  free(): void {
    this._authorizer.free()
    this._poisoned = true
  }

  /** Frees the authorizer at the end of a `using` scope. */
  [Symbol.dispose](): void {
    this.free()
  }

  /** How many tool calls this handler has decided. */
  get decisionCount(): number {
    return this._authorizer.decisionCount
  }

  /** Every fully qualified action id the policy's schema declares. */
  get actions(): readonly string[] {
    return this._authorizer.actions
  }

  /**
   * Feeds one event to the authorizer, converting a wasm trap into a poisoned
   * module rather than letting it escape as an ordinary error.
   */
  private _decide(event: DogwoodEventInput): DogwoodDecisionResult {
    try {
      return this._authorizer.isAuthorized(event)
    } catch (error) {
      // A RuntimeError leaves the whole module in an undefined state, so every
      // later call may fail or trap. Never fail open on it, whatever onError says.
      if (error instanceof WebAssembly.RuntimeError) {
        this._poisoned = true
        return 'trapped'
      }
      throw error
    }
  }

  /**
   * Epoch seconds, never going backwards: the authorizer rejects a timestamp
   * before the previous event's, and a system clock can step back.
   */
  private _timestamp(): number {
    return Math.max(this._now(), this._authorizer.lastTimestamp ?? 0)
  }
}

/** A decision, `undefined` for a history-only event, or a poisoned module. */
type DogwoodDecisionResult = ReturnType<DogwoodAuthorizerInstance['isAuthorized']> | 'trapped'

/** Reads `value` from disk when it names a file with `extension`, else returns it as source text. */
function loadSource(value: string, extension: string): string {
  if (!value.endsWith(extension)) {
    return value
  }
  if (!existsSync(value)) {
    throw new Error(`Dogwood ${extension} file not found: ${value}`)
  }
  return readFileSync(value, 'utf-8')
}

/** Merges field groups per group, with `override`'s fields winning. */
function mergeGroups(base: DogwoodGroups | undefined, override: DogwoodGroups): DogwoodGroups {
  if (!base) {
    return override
  }
  const merged: DogwoodGroups = { ...base }
  for (const [group, fields] of Object.entries(override)) {
    merged[group] = { ...base[group], ...fields }
  }
  return merged
}
