Defined in: [src/decisions/decision-model.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts#L21)

Abstract base for anything that can answer closed questions.

The public `ask` opens a `decision` span, validates the question map, delegates to the subclass `_ask`, records usage, the question ids, and the answer set as span attributes, and closes the span. Content goes on span attributes rather than span events because OpenTelemetry has deprecated the span-event recording API. Every implementation is traced identically. Given an `invocationContext`, `ask` also adds the reported usage to that request once `_ask` returns.

## Extended by

-   [`DecisionsAPIDecisionModel`](/docs/api/typescript/DecisionsAPIDecisionModel/index.md)
-   [`LLMDecisionModel`](/docs/api/typescript/LLMDecisionModel/index.md)
-   [`TypeSafeDecisionModel`](/docs/api/typescript/TypeSafeDecisionModel/index.md)

## Constructors

### Constructor

```ts
new DecisionModel(): DecisionModel;
```

#### Returns

`DecisionModel`

## Methods

### ask()

```ts
ask<Q>(
   state,
   questions,
   options?
): Promise<DecisionResult<Q>>;
```

Defined in: [src/decisions/decision-model.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts#L36)

Ask one or more closed questions over the given state.

#### Type Parameters

| Type Parameter |
| --- |
| `Q` *extends* `Record`<`string`, [`Question`](/docs/api/typescript/Question/index.md)<`"boolean"` | readonly `string`\[\]>> |

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `state` | [`DecisionInput`](/docs/api/typescript/DecisionInput/index.md) | A plain string, a one-shot content list, or a message history. |
| `questions` | `Q` | Map of identifier → question. The returned `answers` object is keyed off this same map and statically narrowed per question. |
| `options?` | [`AskOptions`](/docs/api/typescript/AskOptions/index.md) | Per-call options, such as the request to add the decision’s usage to, or a `cancelSignal` that aborts the underlying call. |

#### Returns

`Promise`<[`DecisionResult`](/docs/api/typescript/DecisionResult/index.md)<`Q`\>>

A [DecisionResult](/docs/api/typescript/DecisionResult/index.md) whose answers are statically narrowed from each question’s `choices`.

#### Throws

Error if `questions` is empty or contains an invalid `question`, `choices`, or `uncertainty`.

#### Throws

TypeError if `options.invocationContext` was not created by the SDK.

---

### \_ask()

```ts
abstract protected _ask<Q>(
   state,
   questions,
   options
): Promise<DecisionResult<Q>>;
```

Defined in: [src/decisions/decision-model.ts:89](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts#L89)

Implementation-specific decision logic. Must return a complete [DecisionResult](/docs/api/typescript/DecisionResult/index.md), including `metadata.latencyMs` sourced from the underlying model provider. Implementations should forward `options.cancelSignal` to any cancellable work they start. The request’s `invocationContext` is not passed: `ask` records the reported usage itself.

#### Type Parameters

| Type Parameter |
| --- |
| `Q` *extends* `Record`<`string`, [`Question`](/docs/api/typescript/Question/index.md)<`"boolean"` | readonly `string`\[\]>> |

#### Parameters

| Parameter | Type |
| --- | --- |
| `state` | [`DecisionInput`](/docs/api/typescript/DecisionInput/index.md) |
| `questions` | `Q` |
| `options` | [`DecisionCallOptions`](/docs/api/typescript/DecisionCallOptions/index.md) |

#### Returns

`Promise`<[`DecisionResult`](/docs/api/typescript/DecisionResult/index.md)<`Q`\>>