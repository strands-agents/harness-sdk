Defined in: [src/decisions/decisions-api-decision-model.ts:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L38)

Decision model backed by decisionapi.net.

## Example

```typescript
const decisions = new DecisionsAPIDecisionModel()
const result = await decisions.ask('A customer needs a refund today.', {
  department: { question: 'Which team should handle this?', choices: ['billing', 'support'] },
})
```

## Extends

-   [`DecisionModel`](/docs/api/typescript/DecisionModel/index.md)

## Constructors

### Constructor

```ts
new DecisionsAPIDecisionModel(options?): DecisionsAPIDecisionModel;
```

Defined in: [src/decisions/decisions-api-decision-model.ts:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L45)

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`DecisionsAPIDecisionModelOptions`](/docs/api/typescript/DecisionsAPIDecisionModelOptions/index.md) | Provider, model, and confidence configuration. |

#### Returns

`DecisionsAPIDecisionModel`

#### Throws

Error if the API key, confidence threshold, or fetch implementation is invalid.

#### Overrides

[`DecisionModel`](/docs/api/typescript/DecisionModel/index.md).[`constructor`](/docs/api/typescript/DecisionModel/index.md#constructor)

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

#### Inherited from

[`DecisionModel`](/docs/api/typescript/DecisionModel/index.md).[`ask`](/docs/api/typescript/DecisionModel/index.md#ask)

---

### \_ask()

```ts
protected _ask<Q>(
   state,
   questions,
   options
): Promise<DecisionResult<Q>>;
```

Defined in: [src/decisions/decisions-api-decision-model.ts:58](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decisions-api-decision-model.ts#L58)

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

#### Overrides

[`DecisionModel`](/docs/api/typescript/DecisionModel/index.md).[`_ask`](/docs/api/typescript/DecisionModel/index.md#_ask)