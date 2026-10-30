Defined in: [src/models/model.ts:79](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L79)

Configuration for prompt caching.

Providers consume only the fields they support.

## Properties

### strategy?

```ts
strategy?: "auto" | "anthropic";
```

Defined in: [src/models/model.ts:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L88)

Whether to skip caching for models that do not support it.

-   “auto”: cache only when the model is known to support it
-   “anthropic”: cache without that check, for model identifiers it cannot inspect (an application inference profile, for example)

#### Default Value

```ts
'auto'
```

---

### ttl?

```ts
ttl?: CacheTTL;
```

Defined in: [src/models/model.ts:100](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L100)

TTL for every cache point, overridden by a per-section TTL. Provider default when omitted.

Bedrock requires checkpoint TTLs to be non-increasing across `toolConfig`, system and messages, and rejects a longer TTL that follows a shorter one. This TTL therefore also fills in for a cache point placed by hand in the system prompt that carries none of its own, so one value keeps every checkpoint in step. A TTL written on such a point is left as written, and a `toolsTTL` that differs from this one leaves the point at the provider default rather than landing a longer TTL behind a shorter checkpoint - either way, two TTLs in tension are yours to reconcile.

---

### toolsTTL?

```ts
toolsTTL?: boolean | CacheTTL;
```

Defined in: [src/models/model.ts:107](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L107)

Cache the tool definitions. A TTL sets this section’s duration; `false` disables it.

#### Default Value

```ts
true
```

---

### systemPromptTTL?

```ts
systemPromptTTL?: boolean | CacheTTL;
```

Defined in: [src/models/model.ts:116](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L116)

Cache the system prompt, auto-injecting a cache point at its end so repeated calls with the same static system prefix hit the cache. A TTL sets this section’s duration; `true` (the default) reads the value from `ttl`; `false` disables systemPrompt cache injection.

#### Default Value

```ts
true
```

---

### messagesTTL?

```ts
messagesTTL?: boolean | CacheTTL;
```

Defined in: [src/models/model.ts:124](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L124)

Cache the conversation prefix, on the last user message. A TTL sets this section’s duration; `false` disables it.

#### Default Value

```ts
true
```

---

### cacheKey?

```ts
cacheKey?: string | false;
```

Defined in: [src/models/model.ts:134](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L134)

Stable identity a prompt-cache-routing provider (OpenAI, LiteLLM) uses as its cache key. Left unset, it is derived per request as `strands-<sessionId>` whenever the agent has a session manager, so repeat runs of a session share a cache prefix with no key management. Set it to a string to pin your own key; set it to `false` to opt out of routing entirely. The resolved key (whether set or derived from the session id) is transmitted to the provider. Because the derived key is resolved per request, it is not reflected in `getConfig()`.