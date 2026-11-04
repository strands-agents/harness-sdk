Defined in: [src/models/routing/classifier-strategy.ts:140](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L140)

Choose a candidate by applying a configurable routing policy with a classifier model.

The classifier is asked one closed question that carries the SDK’s fixed routing rules followed by the routing policy. A [DecisionModel](/docs/api/typescript/DecisionModel/index.md), such as a System One provider, can be passed in place of a model.

Each candidate is offered under a positional key (`c0`, `c1`, …); names, descriptions, and metadata travel only as evidence in the routing context, so optional or arbitrary names never become answer values. The routing context is a bounded projection of the latest request, the parent agent’s textual instructions, and candidate evidence; it crosses the classifier provider boundary and must not contain secrets.

Selection runs only before the first model call. A single candidate is returned without asking. The classifier must commit to a key. Classification failures, unknown keys, and timeouts warn and decline selection, so [ModelRouter](/docs/api/typescript/ModelRouter/index.md) serves candidate zero. After an attempt this strategy declines, so a failure of the selected candidate surfaces without switching. Nested routers are treated as opaque candidates using only their wrapper evidence.

## Example

```typescript
const router = new ModelRouter(
  [
    new RoutingCandidate({ model: fast, name: 'routine', description: 'Short factual requests' }),
    new RoutingCandidate({ model: strong, name: 'complex', description: 'Multi-step design work' }),
  ],
  { strategy: new ClassifierStrategy(classifierModel) }
)
const agent = new Agent({ model: router })
```

## Implements

-   [`RoutingStrategy`](/docs/api/typescript/RoutingStrategy/index.md)

## Constructors

### Constructor

```ts
new ClassifierStrategy(model, options?): ClassifierStrategy;
```

Defined in: [src/models/routing/classifier-strategy.ts:156](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L156)

Create a classifier strategy.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `model` | | [`Model`](/docs/api/typescript/Model/index.md)<[`BaseModelConfig`](/docs/api/typescript/BaseModelConfig/index.md)\> | [`DecisionModel`](/docs/api/typescript/DecisionModel/index.md) | Model or DecisionModel used for classification; a Model must honor forced tool selection (`toolChoice`), since a provider that ignores it fails classification and every selection falls back to candidate zero |
| `options?` | [`ClassifierStrategyOptions`](/docs/api/typescript/ClassifierStrategyOptions/index.md) | Routing policy, timeout, and character budgets |

#### Returns

`ClassifierStrategy`

#### Throws

TypeError if `model` is not a Model or DecisionModel

#### Throws

Error if both `routingPolicy` and `systemPrompt` are set, `timeoutMs` is not finite, greater than zero, and at most 2147483647, or a character limit is not a positive integer

## Methods

### select()

```ts
select(context): Promise<RoutingCandidate>;
```

Defined in: [src/models/routing/classifier-strategy.ts:181](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L181)

Select one opening candidate, declining on a decision failure.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `context` | [`RoutingContext`](/docs/api/typescript/RoutingContext/index.md) | Current request and chronological routing history |

#### Returns

`Promise`<[`RoutingCandidate`](/docs/api/typescript/RoutingCandidate/index.md)\>

The chosen candidate, or `undefined` to decline

#### Throws

Error if the candidates’ serialized evidence exceeds `maxCandidateChars`; this misconfiguration is permanent, so it propagates instead of declining

#### Implementation of

[`RoutingStrategy`](/docs/api/typescript/RoutingStrategy/index.md).[`select`](/docs/api/typescript/RoutingStrategy/index.md#select)