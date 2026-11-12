Defined in: [src/context-manager/methods/truncate.ts:19](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/methods/truncate.ts#L19)

**`Experimental`**

Configuration for the truncate method.

## Properties

### previewTokens?

```ts
previewTokens?: number;
```

Defined in: [src/context-manager/methods/truncate.ts:25](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/methods/truncate.ts#L25)

**`Experimental`**

Number of tokens to keep as preview text. Defaults to 1,000. Content that already fits is left unchanged. For `Offload.truncate('*')`, the budget of whole messages kept at the head and tail; the rest are replaced by one `[... earlier messages elided, ~N tokens ...]` marker.

---

### preview?

```ts
preview?: "head" | "tail" | "headTail";
```

Defined in: [src/context-manager/methods/truncate.ts:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/methods/truncate.ts#L30)

**`Experimental`**

Which portion of the text to keep as preview. Defaults to ‘headTail’. For `Offload.truncate('*')`, `'head'` keeps only the oldest messages and `'tail'` only the newest.