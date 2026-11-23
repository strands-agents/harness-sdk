Defined in: [src/types/messages.ts:798](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L798)

Data for a cache point block.

## Properties

### cacheType

```ts
cacheType: "default";
```

Defined in: [src/types/messages.ts:802](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L802)

The cache type. Currently only ‘default’ is supported.

---

### ttl?

```ts
ttl?: string;
```

Defined in: [src/types/messages.ts:811](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L811)

Optional TTL for the cache entry. When omitted, the provider’s default TTL is used.

The accepted value space is provider-specific. For example, the Bedrock provider only accepts the values defined by `BedrockCacheTTL` (`'5m'` and `'1h'`). Other providers may accept different values or ignore this field.