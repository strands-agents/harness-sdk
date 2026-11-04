Defined in: [src/models/routing/classifier-strategy.ts:83](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L83)

Options for constructing a [ClassifierStrategy](/docs/api/typescript/ClassifierStrategy/index.md).

## Properties

### routingPolicy?

```ts
readonly routingPolicy?: string;
```

Defined in: [src/models/routing/classifier-strategy.ts:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L88)

Routing policy, sent verbatim and never truncated. The SDK adds mandatory isolation, candidate-key, and structured-output rules that the policy cannot override. Defaults to the SDK input-complexity policy.

---

### ~systemPrompt?~

```ts
readonly systemPrompt?: string;
```

Defined in: [src/models/routing/classifier-strategy.ts:90](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L90)

#### Deprecated

Use `routingPolicy`.

---

### timeoutMs?

```ts
readonly timeoutMs?: number;
```

Defined in: [src/models/routing/classifier-strategy.ts:97](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L97)

Maximum milliseconds to wait for the decision. Defaults to 30000. On timeout the in-flight call is aborted through its `cancelSignal`, which is honored implementation- and provider-dependently. The timeout runs independently of agent cancellation: [RoutingContext](/docs/api/typescript/RoutingContext/index.md) carries no cancel signal, so cancelling the agent while a decision is in flight does not abort that decision.

---

### maxMessageChars?

```ts
readonly maxMessageChars?: number;
```

Defined in: [src/models/routing/classifier-strategy.ts:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L99)

Maximum characters copied from the latest request into the routing context. Defaults to 4000.

---

### maxAgentInstructionsChars?

```ts
readonly maxAgentInstructionsChars?: number;
```

Defined in: [src/models/routing/classifier-strategy.ts:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L101)

Maximum characters copied from the parent agent’s system prompt text into the routing context. Defaults to 4000.

---

### maxCandidateChars?

```ts
readonly maxCandidateChars?: number;
```

Defined in: [src/models/routing/classifier-strategy.ts:107](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts#L107)

Maximum aggregate characters for the serialized evidence (names, descriptions, and metadata) of all candidates. Evidence is never truncated; selection throws when the budget is exceeded. Defaults to 4000.