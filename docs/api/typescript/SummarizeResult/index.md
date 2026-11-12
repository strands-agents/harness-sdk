Defined in: [src/models/summarize.ts:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/summarize.ts#L31)

Result of a [Model.summarize](/docs/api/typescript/Model/index.md#summarize) call.

## Properties

### content

```ts
content: ContentBlock[];
```

Defined in: [src/models/summarize.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/summarize.ts#L36)

The summary as `summaryBlock`s, empty when the model wrote none. Every built-in implementation returns at most one block; a caller that places one summary uses the first.

---

### usage?

```ts
usage?: Usage;
```

Defined in: [src/models/summarize.ts:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/summarize.ts#L42)

Token usage of the calls made for the summary, `undefined` when an implementation reports none. The base implementation always reports usage, with zero counts when the provider sent none.