Defined in: [src/models/streaming.ts:535](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L535)

Performance metrics for a model invocation.

## Properties

### latencyMs

```ts
latencyMs: number;
```

Defined in: [src/models/streaming.ts:539](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L539)

Latency in milliseconds.

---

### timeToFirstByteMs?

```ts
timeToFirstByteMs?: number;
```

Defined in: [src/models/streaming.ts:545](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts#L545)

Time to first byte in milliseconds. Latency from sending the model request to receiving the first content chunk.