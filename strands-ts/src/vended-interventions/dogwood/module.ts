/**
 * The slice of `@aws/dogwood-wasm` that {@link DogwoodAuthorization} depends on.
 *
 * Declared locally rather than imported so the handler type-checks and unit-tests
 * without the wasm package present. The package is an optional peer dependency;
 * callers either pass the module in or let {@link loadDogwoodModule} import it.
 */

/** @internal Package the module is imported from when none is supplied. */
export const DOGWOOD_PACKAGE = '@aws/dogwood-wasm'

/** @internal Cedar's decision for one event. Nameable only through {@link DogwoodModule}. */
export type DogwoodVerdict = 'allow' | 'deny'

/** @internal A structured entity reference. The id is raw — Dogwood escapes it exactly once. */
export interface DogwoodEntityRef {
  /** Entity type, namespace included (`'Drupe::User'`). */
  type: string
  /** The raw, un-escaped entity id. */
  id: string
}

/**
 * A Dogwood field value. JSON values map to their Dogwood counterparts; two
 * tagged forms cover what JSON cannot express — an entity reference, and a
 * decimal whose exact text matters (`1.50` would round-trip as `1.5`).
 *
 * @internal Nameable only through {@link DogwoodAuthorizationConfig}.
 */
export type DogwoodValue =
  | null
  | boolean
  | number
  | string
  | DogwoodValue[]
  | { __entity: DogwoodEntityRef }
  | { __decimal: string }
  | { [key: string]: DogwoodValue }

/** @internal One entity supplied to a decision: identity, readable attributes, direct parents. */
export interface DogwoodEntityInput extends DogwoodEntityRef {
  /** Attributes a policy may read (`principal.dept`). */
  attrs?: Record<string, DogwoodValue>
  /** Direct `memberOf` edges only — Cedar computes the transitive closure. */
  parents?: DogwoodEntityRef[]
}

/** @internal Event field groups, `group -> { field -> value }`. */
export type DogwoodGroups = Record<string, Record<string, DogwoodValue>>

/** @internal One event fed to the authorizer. Nameable only through {@link DogwoodAuthorizerInstance}. */
export interface DogwoodEventInput {
  /** Fully qualified Cedar action id with an unquoted id (`'Drupe::Action::search'`). */
  action: string
  /** Event kind. `'request'` decides; `'response'`/`'error'` are history-only. */
  kind?: string
  /** Wall-clock time in SECONDS, non-decreasing across calls on one instance. */
  timestamp?: number
  /** The request principal. */
  principal?: DogwoodEntityRef
  /** The request resource. */
  resource?: DogwoodEntityRef
  /** The durable temporal record, correlated against by later events. */
  logged?: DogwoodGroups
  /** The ephemeral Cedar request context, read as `context.<group>.<field>`. */
  context?: DogwoodGroups
  /** Entity store for this decision. */
  entities?: DogwoodEntityInput[]
}

/** @internal The decision for one decision-kind event. Nameable only through {@link DogwoodModule}. */
export interface DogwoodDecision {
  /** 0-based index in the decision stream; history-only events do not advance it. */
  index: number
  /** The event's timestamp, echoed back. */
  timestamp: number
  /** Cedar's decision, forced to `'deny'` whenever `errors` is non-empty. */
  verdict: DogwoodVerdict
  /** `true` exactly when the policy allowed and evaluation raised no errors. */
  allowed: boolean
  /**
   * The `.dw` rule indices that determined the decision. Empty for an implicit
   * deny and for a fail-closed deny. Snake_case because it is a wire field name
   * from the wasm binding.
   */
  determining_rules: number[]
  /** Evaluation errors. Non-empty means something went wrong, not "policy said no". */
  errors: string[]
}

/**
 * A live, stateful Dogwood authorizer. One instance is one ordered history.
 *
 * @internal Nameable only through {@link DogwoodModule}.
 */
export interface DogwoodAuthorizerInstance {
  /**
   * Authorize one event, or record a history-only one.
   *
   * @param event - The event to decide or record.
   * @returns The decision, or `undefined` for a history-only event.
   * @throws A `DogwoodError` when the event is malformed or names an action,
   * kind, or backwards timestamp the instance will not accept. The instance is
   * left usable and its history untouched.
   */
  isAuthorized(event: DogwoodEventInput): DogwoodDecision | undefined
  /** Drop accumulated temporal history and re-lower the original sources. */
  reset(): void
  /** Release the wasm-heap memory this instance owns. */
  free(): void
  /** Every fully qualified action id this instance can decide. */
  readonly actions: string[]
  /** Every event kind the event schema declares. */
  readonly eventKinds: string[]
  /** The subset of `eventKinds` that yield a verdict. */
  readonly decisionKinds: string[]
  /** How many decisions this instance has returned. */
  readonly decisionCount: number
  /** Timestamp of the most recent event observed, or `undefined` before the first. */
  readonly lastTimestamp: number | undefined
}

/** @internal The `@aws/dogwood-wasm` exports this handler uses. */
export interface DogwoodModule {
  /** Lowers a `.dw` policy set against a Cedar action schema into a live authorizer. */
  DogwoodAuthorizer: new (
    source: string,
    actionSchema: string,
    eventSchema?: string,
    providers?: string,
    macros?: string
  ) => DogwoodAuthorizerInstance
  /** Generates Cedar action-schema text from an MCP `tools/list` manifest. */
  mcpToCedarSchema(manifestJson: string): string
}

/**
 * Imports {@link DOGWOOD_PACKAGE} at runtime.
 *
 * @returns The loaded module.
 * @throws Error when the package is not installed, naming the `module` config
 * field as the alternative.
 * @internal Callers reach this through {@link DogwoodAuthorization.create}, or
 * import the package themselves and pass it as `config.module`.
 */
export async function loadDogwoodModule(): Promise<DogwoodModule> {
  // Widened to `string` so TypeScript does not resolve the specifier at build
  // time: the package is optional and is often absent.
  const specifier: string = DOGWOOD_PACKAGE
  try {
    return (await import(/* @vite-ignore */ specifier)) as unknown as DogwoodModule
  } catch (error) {
    throw new Error(
      `${DOGWOOD_PACKAGE} could not be loaded. Install it, or pass the module via the \`module\` config field.`,
      { cause: error }
    )
  }
}
