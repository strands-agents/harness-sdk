Defined in: [src/context-manager/strategies/offload/summarize.ts:54](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/summarize.ts#L54)

Configuration for the summarize strategy.

## Properties

### model?

```ts
model?: Model;
```

Defined in: [src/context-manager/strategies/offload/summarize.ts:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/summarize.ts#L56)

Model used for summarization. Resolution order: `this model > agent.model`.

---

### systemPrompt?

```ts
systemPrompt?: string;
```

Defined in: [src/context-manager/strategies/offload/summarize.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/summarize.ts#L59)

Summarization instructions closing each summary request, replacing the default ones.