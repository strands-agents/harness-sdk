import { readFileSync, existsSync } from 'node:fs'
import { DogwoodAuthorizer, mcpToCedarSchema, validate } from '@aws/dogwood-wasm'
import { InterventionHandler } from '../../interventions/handler.js'
import { proceed, deny } from '../../interventions/actions.js'
import { logger } from '../../logging/logger.js'
import type { AuthorizerDecision, Diagnostic, DogwoodValue, EntityInput, EntityRef } from '@aws/dogwood-wasm'
import type { InterventionAction, Proceed } from '../../interventions/actions.js'
import type { BeforeToolCallEvent, AfterToolCallEvent } from '../../hooks/events.js'
import type { OnError } from '../../interventions/handler.js'
import type { Tool } from '../../tools/tool.js'
import type { ToolSpec } from '../../tools/types.js'
import type { InvocationState } from '../../types/agent.js'

/** The one context group a {@link DogwoodAuthorizationConfig.contextEnricher} can add. */
const ENRICHED_GROUP = 'session'

/** The namespace Dogwood's schema generator emits. It takes no namespace of its own. */
const GENERATED_NAMESPACE = 'Drupe'

/** The resource entity Dogwood's schema generator emits, from its MCP-gateway template. */
const GENERATED_RESOURCE = 'Gateway'

/** The resource entity a schema declares, matching `CedarAuthorization`. */
const RESOURCE = 'Resource'

/** A Cedar namespace: one or more `::`-separated identifiers. */
const CEDAR_NAMESPACE = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/

/** Identifiers Cedar's grammar admits as a namespace and its parser then rejects. */
const CEDAR_RESERVED = new Set(['true', 'false', 'if', 'then', 'else', 'in', 'is', 'like', 'has'])

/** Cedar reserves this prefix for its own types. */
const CEDAR_INTERNAL_PREFIX = '__cedar'

/** Event field groups, `group -> { field -> value }`. */
type EventGroups = Record<string, Record<string, DogwoodValue>>

/** What recording a tool's result needs, captured when the call was allowed. */
interface AllowedCall {
  /** The tool the allow was decided for. */
  toolName: string
  /** The action id the request event was recorded under. */
  action: string
  /** The principal the request event was recorded under. */
  principal: EntityRef
  /** The fields the request event logged. */
  logged: EventGroups
}

/**
 * Configuration for the {@link DogwoodAuthorization} intervention handler.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood | Dogwood}
 */
export interface DogwoodAuthorizationConfig {
  /** Dogwood policy text, or a path to a `.dw` file on disk. */
  policies: string

  /** Tools the action schema is generated from. Pass the tools themselves or their specs. */
  tools?: (Tool | ToolSpec)[]

  /**
   * Cedar action schema text, or a path to a `.cedarschema` file. Generated
   * from `tools` when omitted.
   *
   * The handler reads the namespace from the schema's actions and derives the
   * default principal and the resource from it, so the schema must declare its
   * user entity as `User` and its resource entity as `Resource`.
   */
  actionSchema?: string

  /**
   * Entities supplied to every decision — attributes and hierarchy a policy reads.
   *
   * Requires `actionSchema`; a non-empty list alongside `tools` throws, because a
   * generated schema declares `entity User;` / `entity Resource;` with no
   * attributes and no membership, so an entity carrying either fails
   * conformance at decision time and denies every call.
   */
  entities?: EntityInput[]

  /**
   * Namespace for a generated action schema. Omit it and the actions and
   * entities are declared at the top level, so policies name `Action::"<tool>"`
   * and the default principal is `User::"anonymous"`.
   *
   * Set it to qualify every one of those — `Acme::Action::"<tool>"` — which a
   * policy then spells out in each rule that scopes an action, names a
   * principal, reads `context.input`, or writes a temporal predicate. A
   * `principal` or `principalResolver` carries the qualified type too, as in
   * `{ type: 'Acme::User', id: 'alice' }`.
   *
   * Only valid with `tools`; a hand-written `actionSchema` declares its own.
   */
  namespace?: string

  /**
   * Static principal. Defaults to `User::"anonymous"`, qualified by the schema's
   * namespace when it declares one. Mutually exclusive with `principalResolver`.
   *
   * A generated schema declares `User` as its only principal type, so any other
   * type throws. A hand-written `actionSchema` declares its own.
   */
  principal?: EntityRef

  /**
   * Dynamic principal resolver for multi-tenant agents.
   * Return `undefined` to deny (fail-closed). Mutually exclusive with `principal`.
   *
   * Against a generated schema the type must be `User`, qualified by
   * `namespace`; any other type denies the call.
   */
  principalResolver?: ((invocationState: InvocationState) => EntityRef | undefined) | undefined

  /**
   * Adds fields to the `session` group of the Cedar request context, read by a
   * policy as `context.session.<field>`. Use it to forward `invocationState`
   * values a tool's arguments do not carry.
   *
   * These fields reach the `when { … }` condition only. The default event
   * schema declares a tool's input fields and nothing else, so a temporal
   * predicate cannot reference an enriched field. Correlating history by
   * principal needs no enricher — the default schema pins every predicate to
   * the deciding principal already.
   */
  contextEnricher?:
    | ((context: {
        toolName: string
        toolInput: Record<string, unknown>
        invocationState: InvocationState
      }) => Record<string, DogwoodValue>)
    | undefined

  /**
   * What to do when `principalResolver` or `contextEnricher` throws: `'throw'`
   * (default) rethrows, `'deny'` denies the tool call (fail-closed).
   *
   * **Warning:** `'proceed'` is fail-open — the tool runs with no authorization
   * check. A failed Dogwood decision always denies regardless of this setting.
   */
  onError?: OnError | undefined
}

/**
 * Dogwood authorization intervention handler. Evaluates a `.dw` policy set
 * before each tool call, and records the result afterward so temporal rules work.
 *
 * Each tool maps to: Action = `Action::<tool name>`, qualified by the schema's
 * namespace when it has one, Principal = the configured/resolved user,
 * Resource = the gateway, and `input` = the tool arguments in both the Cedar
 * context and the temporal record.
 *
 * Holds temporal history, so one instance is one ordered history. Every
 * temporal predicate is pinned to the deciding principal, so one instance
 * serves many principals without their histories mixing. History is never
 * pruned; {@link reset} drops every principal's at once.
 *
 * A tool's result is not recorded, only the fact that it returned, so a
 * predicate on a result field (`response{ output.x: … }`) type-checks and then
 * never matches. A condition compares the tool arguments as the model emitted
 * them, and a generated schema is typed to match, so an enum parameter is
 * compared as a string and a number parameter as a whole number.
 *
 * @see {@link https://github.com/dogwood-policy/dogwood-wasm | dogwood-wasm}
 *
 * @example
 * ```typescript
 * const dogwood = new DogwoodAuthorization({
 *   policies: 'permit(principal, action == Action::"search", resource);',
 *   tools: [searchTool],
 * })
 *
 * const agent = new Agent({ model, tools: [searchTool], interventions: [dogwood] })
 * ```
 */
export class DogwoodAuthorization extends InterventionHandler {
  readonly name = 'dogwood-authorization'
  override readonly onError: OnError

  private readonly _principalResolver: DogwoodAuthorizationConfig['principalResolver']
  private readonly _contextEnricher: DogwoodAuthorizationConfig['contextEnricher']
  private readonly _entities: EntityInput[]

  /** Holds the policy set and the temporal history it decides against. */
  private readonly _authorizer: DogwoodAuthorizer

  /** Action id by tool name, as the schema declares them. */
  private readonly _actionsByTool: ReadonlyMap<string, string>

  /** The event kinds the schema declares, so an undeclared kind is not fed. */
  private readonly _declaredKinds: ReadonlySet<string>

  /** The gateway resource every call is decided against. */
  private readonly _resource: EntityRef

  /** The principal to decide under, or `undefined` when a resolver supplies it. */
  private readonly _defaultPrincipal: EntityRef | undefined

  /**
   * The only entity type a generated schema admits as a principal, or
   * `undefined` for a hand-written schema, which may declare several.
   *
   * An undeclared principal type is not an error to Dogwood: validation passes
   * and the decision allows, because a rule that scopes the principal simply
   * never matches. Checking it is the difference between a typo being caught
   * and a `forbid` silently not applying.
   */
  private readonly _principalType: string | undefined

  /**
   * Set by a wasm trap. The module is shared process-wide, so a trap is not
   * assumed recoverable and every later decision denies without calling in.
   */
  private _unusable = false

  /**
   * Calls decided and allowed, by tool-use id, until their result is recorded.
   * Keeps a call another handler blocked out of the temporal history, and keeps
   * a resumed interrupt from being decided twice.
   *
   * Holds what the result event needs so the after phase runs no user code: a
   * resolver must not be asked twice and allowed to answer differently, or to
   * throw after the tool has already run.
   */
  private readonly _allowedCalls = new Map<string, AllowedCall>()

  /**
   * @param config - Handler configuration.
   * @throws Error when neither `actionSchema` nor `tools` is supplied, when
   * both `principal` and `principalResolver` are, when `entities` is non-empty
   * without `actionSchema`, when `namespace` is supplied with one or is not a
   * legal Cedar namespace, when `principal` is not of the type a generated
   * schema declares, or when the policy set does not type-check against the
   * schema. Throws a `DogwoodError` when the policy set, the schema, or a tool
   * manifest fails to parse.
   */
  constructor(config: DogwoodAuthorizationConfig) {
    super()
    if (config.principal && config.principalResolver) {
      throw new Error('Provide either `principal` or `principalResolver`, not both')
    }
    if (!config.actionSchema && !config.tools) {
      throw new Error('Provide either `actionSchema` or `tools`')
    }
    // A generated schema declares its entities with no attributes and no
    // membership, so an entity carrying either fails conformance and denies
    // every call.
    if (config.entities?.length && !config.actionSchema) {
      throw new Error('`entities` requires `actionSchema`; a generated schema declares no entity attributes')
    }
    if (config.namespace !== undefined && config.actionSchema) {
      throw new Error('`namespace` applies to a generated schema; a hand-written `actionSchema` declares its own')
    }
    assertCedarNamespace(config.namespace)

    const policies = loadSource(config.policies, '.dw')
    const actionSchema = config.actionSchema
      ? loadSource(config.actionSchema, '.cedarschema')
      : applyNamespace(generateActionSchema(config.tools), config.namespace)
    // The one finding a generated schema causes by construction: it cannot
    // declare the enricher's context group. Everything else is fatal, including
    // a typo in a temporal predicate.
    const tolerateEnrichedGroup = !config.actionSchema && config.contextEnricher !== undefined
    assertPolicyTypeChecks(validate(policies, actionSchema).errors, tolerateEnrichedGroup)

    this._authorizer = new DogwoodAuthorizer(policies, actionSchema)
    // The schema is the source of truth for both the action ids and the
    // namespace, so a policy and a schema can never disagree about either.
    const namespace = namespacePrefixOf(this._authorizer.actions)
    this._actionsByTool = new Map(
      // Keyed by the unquoted tool name in each fully qualified action id.
      this._authorizer.actions.map((action) => [action.slice(action.lastIndexOf('::') + 2), action])
    )
    this._declaredKinds = new Set(this._authorizer.eventKinds)
    this._resource = { type: `${namespace}${RESOURCE}`, id: 'agent' }
    this._principalType = config.actionSchema ? undefined : `${namespace}User`
    this._defaultPrincipal = config.principalResolver
      ? undefined
      : (config.principal ?? { type: `${namespace}User`, id: 'anonymous' })
    const principalType = this._defaultPrincipal?.type
    if (principalType !== undefined && !this._declaresPrincipalType(principalType)) {
      throw new Error(`\`principal\` must be of type \`${this._principalType}\`, got \`${principalType}\``)
    }
    this._principalResolver = config.principalResolver
    this._contextEnricher = config.contextEnricher
    this._entities = config.entities ?? []
    this.onError = config.onError ?? 'throw'
  }

  override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
    if (this._unusable) {
      return deny('Dogwood authorizer is no longer usable; denying')
    }
    const toolName = event.toolUse.name
    // Resuming an interrupt re-fires this event; the call is already in the
    // history, so deciding again would count it twice. The tool name is matched
    // too, so an abandoned interrupt's entry cannot wave through a later call
    // that reuses its id for a different tool.
    if (this._allowedCalls.get(event.toolUse.toolUseId)?.toolName === toolName) {
      return proceed()
    }
    this._allowedCalls.delete(event.toolUse.toolUseId)

    const invocationState = event.invocationState
    const principal = this._defaultPrincipal ?? this._principalResolver?.(invocationState)
    if (!principal?.type || !principal.id) {
      return deny('No principal identity found in invocation state')
    }
    if (!this._declaresPrincipalType(principal.type)) {
      return deny(`Principal type '${principal.type}' is not declared by the Dogwood action schema; denying`)
    }

    const action = this._actionsByTool.get(toolName)
    if (!action) {
      return deny(`Tool '${toolName}' is not declared by the Dogwood action schema; denying`)
    }

    const fields = this._eventFields(event.toolUse.input, toolName, invocationState)
    let decision: AuthorizerDecision | undefined
    try {
      decision = this._authorizer.isAuthorized({
        action,
        kind: 'request',
        timestamp: this._timestamp(),
        principal,
        resource: this._resource,
        logged: fields.logged,
        context: fields.context,
        entities: this._entities,
      })
    } catch (error) {
      return this._denyFailedDecision(error)
    }

    const denial = denialReason(decision, toolName)
    if (denial) {
      return deny(denial)
    }
    this._allowedCalls.set(event.toolUse.toolUseId, { toolName, action, principal, logged: fields.logged })
    return proceed()
  }

  override afterToolCall(event: AfterToolCallEvent): Proceed {
    // A blocked call still reaches here, so only a call this handler allowed is
    // a candidate for the history.
    const allowed = this._allowedCalls.get(event.toolUse.toolUseId)
    if (this._unusable || allowed?.toolName !== event.toolUse.name) {
      return proceed()
    }
    this._allowedCalls.delete(event.toolUse.toolUseId)
    // An error status with no `Error` is ambiguous: it is how the executor
    // reports a call a later handler blocked, and also how a tool that builds
    // its own error result reports a real failure. Only a thrown error proves
    // the tool ran.
    if (event.result.status === 'error' && event.error === undefined) {
      return proceed()
    }

    const kind = event.error ? 'error' : 'response'
    if (!this._declaredKinds.has(kind)) {
      return proceed()
    }

    try {
      // History-only: returns no verdict, so there is nothing to enforce. The
      // enriched group is a `when { … }` input the event schema cannot declare,
      // so a result event carries the logged fields alone. The principal and
      // action are the ones the request was decided under, not freshly resolved
      // ones.
      this._authorizer.isAuthorized({
        action: allowed.action,
        kind,
        timestamp: this._timestamp(),
        principal: allowed.principal,
        resource: this._resource,
        logged: allowed.logged,
        context: allowed.logged,
        entities: this._entities,
      })
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        this._unusable = true
      }
      // An unrecorded result cannot be enforced, so a later rule keyed on it
      // does not fire. Failing the tool call that already ran is worse.
      logger.warn(
        `tool=<${allowed.toolName}>, kind=<${kind}> | dogwood could not record a tool result, ${messageOf(error)}`
      )
    }

    return proceed()
  }

  /**
   * Drops accumulated temporal history. Clears every principal this instance
   * has decided for, not one session's history.
   */
  reset(): void {
    if (this._unusable) {
      return
    }
    // An in-flight call allowed against the old history must not record its
    // response into the new one.
    this._allowedCalls.clear()
    this._authorizer.reset()
  }

  /** Whether the schema admits `type` as a principal. Always true for a hand-written one. */
  private _declaresPrincipalType(type: string): boolean {
    return this._principalType === undefined || type === this._principalType
  }

  /**
   * The durable record and the Cedar context for one tool call. Only the tool's
   * input is recorded, because the default event schema declares nothing else a
   * temporal predicate could read.
   */
  private _eventFields(
    toolInput: unknown,
    toolName: string,
    invocationState: InvocationState
  ): { logged: EventGroups; context: EventGroups } {
    const input = (toolInput ?? {}) as Record<string, DogwoodValue>
    const logged = { input }
    if (!this._contextEnricher) {
      return { logged, context: logged }
    }
    const enriched = this._contextEnricher({
      toolName,
      toolInput: input as Record<string, unknown>,
      invocationState,
    })
    return { logged, context: { input, [ENRICHED_GROUP]: enriched } }
  }

  /**
   * Turns a failed `isAuthorized` call into a denial, latching a wasm trap.
   *
   * Upstream's contract is that a thrown call is *no decision* and the host must
   * treat it as a deny. Tool arguments are model output, so letting it escape
   * would hand a fail-open path to `onError: 'proceed'` that the model can reach
   * by adding one junk argument.
   */
  private _denyFailedDecision(error: unknown): InterventionAction {
    if (error instanceof WebAssembly.RuntimeError) {
      this._unusable = true
      return deny('Dogwood evaluation trapped the wasm module; denying')
    }
    return deny(`Dogwood could not decide: ${messageOf(error)}`)
  }

  /**
   * Epoch seconds, never going backwards: the authorizer rejects a timestamp
   * before the previous event's, and a system clock can step back.
   */
  private _timestamp(): number {
    return Math.max(Math.floor(Date.now() / 1000), this._authorizer.lastTimestamp ?? 0)
  }
}

/** The denial reason for a decision, or `undefined` when it allowed. */
function denialReason(decision: AuthorizerDecision | undefined, toolName: string): string | undefined {
  // A decision kind always yields a verdict; treat an absent one as fail-closed.
  if (!decision) {
    return `No Dogwood decision returned for '${toolName}'; denying`
  }
  if (decision.allowed) {
    return undefined
  }
  if (decision.errors.length > 0) {
    return `Dogwood evaluation failed: ${decision.errors.join(', ')}`
  }
  const rules = decision.determining_rules
  return `Access denied by Dogwood policy${rules.length ? ` (rule ${rules.join(', ')})` : ''}`
}

/**
 * Throws unless every validation error is one a generated schema causes by
 * construction, so a policy that could only ever deny is rejected here rather
 * than at the first tool call.
 *
 * Cedar reports the shallowest missing attribute, so an enriched group reads as
 * a bare `session` while a typo inside a declared group keeps its dotted path.
 *
 * @param errors - The validation errors to judge.
 * @param tolerateEnrichedGroup - Whether an enricher supplies a context group the schema cannot declare.
 * @throws Error naming every error that applies.
 */
function assertPolicyTypeChecks(errors: Diagnostic[], tolerateEnrichedGroup: boolean): void {
  const fatal = errors.filter(
    (error) => !(tolerateEnrichedGroup && error.message.includes(`attribute \`${ENRICHED_GROUP}\` in context`))
  )
  if (fatal.length > 0) {
    throw new Error(`Dogwood policy validation failed: ${fatal.map((error) => error.message).join(', ')}`)
  }
}

/**
 * Validates a configured namespace up front, because an illegal one surfaces as
 * a schema parse error naming generated text the caller never wrote.
 *
 * @param namespace - The configured namespace, or `undefined` when there is none.
 * @throws Error when the namespace is not `::`-separated Cedar identifiers, or
 * any segment is one Cedar reserves.
 */
function assertCedarNamespace(namespace: string | undefined): void {
  if (namespace === undefined) {
    return
  }
  const reserved = namespace
    .split('::')
    .some((segment) => CEDAR_RESERVED.has(segment) || segment.startsWith(CEDAR_INTERNAL_PREFIX))
  if (!CEDAR_NAMESPACE.test(namespace) || reserved) {
    throw new Error(`\`namespace\` must be \`::\`-separated Cedar identifiers, none of them reserved: '${namespace}'`)
  }
}

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

/**
 * Generates the Cedar action schema from tool specs.
 *
 * A `Tool` satisfies `ToolSpec` structurally, so the spec has to be unwrapped: a
 * tool passed through as-is yields a schema with no input fields.
 */
function generateActionSchema(tools: (Tool | ToolSpec)[] | undefined): string {
  const specs = tools?.map((tool) => ('toolSpec' in tool ? tool.toolSpec : tool))
  return renameResource(mcpToCedarSchema(JSON.stringify(specs, retypeForRawArguments)))
}

/**
 * Renames the generator's resource entity to the one `CedarAuthorization` uses,
 * so a policy naming the resource reads the same against either handler.
 *
 * Only the declaration and the action references are rewritten: a tool or
 * parameter whose own name contains {@link GENERATED_RESOURCE} must keep it, or
 * the action it declares becomes unreachable.
 */
function renameResource(schema: string): string {
  return schema
    .replace(`entity ${GENERATED_RESOURCE};`, `entity ${RESOURCE};`)
    .replaceAll(`resource: [${GENERATED_RESOURCE}]`, `resource: [${RESOURCE}]`)
}

/**
 * Retypes a parameter to the JSON a condition actually compares against.
 * Generation types an `enum` constraint as an entity type and a `number` as
 * `decimal`, neither of which a raw argument matches: the Cedar-typed form
 * type-checks and then never fires, and `decimal` rejects the ordering
 * operators. Dropping the constraint generates `String` instead, and promoting
 * `number` to `integer` generates `Long`.
 *
 * Only an array-valued `enum` and the exact string `'number'` are rewritten, so
 * a parameter *named* `enum` or `type` is untouched.
 */
function retypeForRawArguments(key: string, value: unknown): unknown {
  if (key === 'enum' && Array.isArray(value)) {
    return undefined
  }
  return key === 'type' && value === 'number' ? 'integer' : value
}

/**
 * Declares a generated schema under `namespace`, or at the top level when there
 * is none. Generation hardcodes {@link GENERATED_NAMESPACE} and takes no
 * namespace of its own, so the name is rewritten after the fact.
 *
 * An object parameter is generated as its own entity type and referenced
 * qualified, so those references move with the declaration. They are rewritten
 * first, so the rename does not have to exclude the declaration itself.
 */
function applyNamespace(schema: string, namespace: string | undefined): string {
  if (namespace === GENERATED_NAMESPACE) {
    return schema
  }
  const requalified = schema.replaceAll(`${GENERATED_NAMESPACE}::`, namespace === undefined ? '' : `${namespace}::`)
  if (namespace !== undefined) {
    return requalified.replace(`namespace ${GENERATED_NAMESPACE} {`, `namespace ${namespace} {`)
  }
  return requalified.replace(`namespace ${GENERATED_NAMESPACE} {`, '').replace(/\}\s*$/, '')
}

/** The namespace the schema's actions live in, as a prefix ready to concatenate. */
function namespacePrefixOf(actions: string[]): string {
  const marker = '::Action::'
  // Last, so a namespace with an `Action` segment of its own stays whole.
  const index = actions[0]?.lastIndexOf(marker) ?? -1
  return index > 0 ? actions[0]!.slice(0, index + 2) : ''
}

/** The message of a thrown value, however it was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
