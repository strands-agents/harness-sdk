```ts
type DeferTarget = "toolSpecs" | string[];
```

Defined in: [src/context-manager/strategies/deferred-tool-loading.ts:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/deferred-tool-loading.ts#L55)

**`Experimental`**

Which tools `Offload.defer` defers: `'toolSpecs'` for every one, or tool names as in other offload targets. Names to defer may be prefixed with `tool::`, and names prefixed with `!` are kept in full. A list of only exclusions defers every other tool.