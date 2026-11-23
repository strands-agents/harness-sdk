Defined in: [src/context-manager/strategies/deferred-tool-loading.ts:65](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/deferred-tool-loading.ts#L65)

**`Experimental`**

When `Offload.defer` defers tools, checked on every model call against that call’s tools. Either condition is enough; with none, it defers at any tool count. The same tools and conditions always defer the same tools, so the tools list stays the same from call to call and after a session restore. A tool change that meets a condition mid-conversation defers from the next call on, so the model then loads tools it was calling directly.

## Properties

### toolCount?

```ts
toolCount?: number;
```

Defined in: [src/context-manager/strategies/deferred-tool-loading.ts:70](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/deferred-tool-loading.ts#L70)

**`Experimental`**

Tools in the call at or above which it defers: a whole number above 0. The SDK’s own tools count, but not the structured output tool, so an invocation with structured output defers the same tools as one without.

---

### schemaTokens?

```ts
schemaTokens?: number | `${number}%`;
```

Defined in: [src/context-manager/strategies/deferred-tool-loading.ts:75](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/deferred-tool-loading.ts#L75)

**`Experimental`**

Estimated tokens of the input schemas it would defer, at or above which it defers: a whole number above 0, or `'5%'` of the context window.