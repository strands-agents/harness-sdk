Defined in: [src/context-manager/methods/summarize.ts:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/methods/summarize.ts#L56)

**`Experimental`**

Configuration for the summarize method.

## Properties

### model?

```ts
model?: Model;
```

Defined in: [src/context-manager/methods/summarize.ts:58](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/methods/summarize.ts#L58)

**`Experimental`**

Model used for summarization. Resolution order: `this model > agent.auxModel > agent.model`.

---

### systemPrompt?

```ts
systemPrompt?: string;
```

Defined in: [src/context-manager/methods/summarize.ts:61](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/methods/summarize.ts#L61)

**`Experimental`**

Custom system prompt for the summarization model.