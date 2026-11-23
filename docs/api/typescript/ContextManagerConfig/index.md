Defined in: [src/context-manager/types.ts:116](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L116)

Full configuration for a ContextManager instance.

## Properties

### strategies?

```ts
strategies?: (
  | ContextStrategy
  | "proactiveSummarization"
  | "largeToolOffloading"
  | "overflowProtection"
  | "staleToolCleanup"
  | "deferredToolLoading")[];
```

Defined in: [src/context-manager/types.ts:126](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L126)

Strategies for context reduction. Applied as an ordered pipeline: each strategy sees the output of the previous. Order determines priority — if two strategies target the same content, the first one to shrink it below the next strategy’s threshold wins. When omitted, uses the default pipeline.

Accepts raw `ContextStrategy` objects, preset name strings (e.g. `'largeToolOffloading'`), or a mix of both. Preset strings are resolved to their default strategy configurations.

---

### archive?

```ts
archive?: boolean | ArchiveConfig;
```

Defined in: [src/context-manager/types.ts:136](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L136)

L1 archive configuration. The archive persists offloaded content so the agent can retrieve it on demand via the `retrieve_context` tool.

-   Omit or `true` → archive enabled with InMemoryStorage (default)
-   `{ storage }` → archive enabled with the given backend
-   `false` → archive disabled (no persistence, no retrieval tool)

---

### ~stash?~

```ts
stash?: boolean | ArchiveConfig;
```

Defined in: [src/context-manager/types.ts:142](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/types.ts#L142)

#### Deprecated

Renamed to `archive`. Honored when `archive` is omitted, with a warning. Removed in the next minor.