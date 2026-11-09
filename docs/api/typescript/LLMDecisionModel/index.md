Defined in: [src/decisions/llm-decision-model.ts:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L78)

Adapter that turns any [Model](/docs/api/typescript/Model/index.md) into a [DecisionModel](/docs/api/typescript/DecisionModel/index.md).

`ask` is implemented as one direct model call with a dynamically-built StructuredOutputTool and forced `toolChoice`. Uncertainty is modeled by appending an `'uncertain'` option to each permitting question’s enum.

## Example

```typescript
const decision = new LLMDecisionModel({ model: new BedrockModel({ strictTools: true }) })
const result = await decision.ask('The fruit is an apple', {
  color: {
    question: 'What color is the fruit?',
    choices: ['red', 'green', 'blue'],
  },
  isFruit: {
    question: 'Is the thing talked about a fruit?',
    choices: 'boolean',
    uncertainty: false,
  },
})
// result.answers.color   is 'red' | 'green' | 'blue' | Uncertain
// result.answers.isFruit is boolean | Uncertain
//   (opting out via `uncertainty: false` only removes 'uncertain' from the
//    model's enum; the static type still includes Uncertain for safety)
```

## Extends

-   [`DecisionModel`](/docs/api/typescript/DecisionModel/index.md)

## Constructors

### Constructor

```ts
new LLMDecisionModel(options?): LLMDecisionModel;
```

Defined in: [src/decisions/llm-decision-model.ts:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L88)

Create an LLM-backed decision model.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `options?` | [`LLMDecisionModelOptions`](/docs/api/typescript/LLMDecisionModelOptions/index.md) | Model and prompt configuration. |

#### Returns

`LLMDecisionModel`

#### Throws

TypeError if `options.model` is not a [Model](/docs/api/typescript/Model/index.md).

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

Defined in: [src/decisions/decision-model.ts:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts#L35)

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

Defined in: [src/decisions/llm-decision-model.ts:96](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L96)

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