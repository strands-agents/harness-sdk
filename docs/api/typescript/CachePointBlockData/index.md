Defined in: [src/types/messages.ts:735](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L735)

Data for a cache point block.

## Properties

### cacheType

```ts
cacheType: "default";
```

Defined in: [src/types/messages.ts:739](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L739)

The cache type. Currently only ‘default’ is supported.

---

### ttl?

```ts
ttl?: string;
```

Defined in: [src/types/messages.ts:748](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L748)

Optional TTL for the cache entry. When omitted, the provider’s default TTL is used.

The accepted value space is provider-specific. For example, the Bedrock provider only accepts the values defined by `BedrockCacheTTL` (`'5m'` and `'1h'`). Other providers may accept different values or ignore this field.