Defined in: [src/context-manager/strategies/offload/base.ts:54](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L54)

**`Experimental`**

Conditions that determine when an offload strategy fires.

Granularity is determined by which conditions are set:

-   `threshold` only → per-block, eager (act on each block above this size on message arrival)
-   `utilization` only → message-level (remove/summarize oldest messages when utilization exceeded)
-   Both → message-level, targeting only messages with blocks over the threshold

When multiple strategies target the same content, they don’t conflict — strategies run as an ordered pipeline, and once an earlier strategy shrinks a block, it falls below the next strategy’s threshold and gets skipped automatically.

## Properties

### threshold?

```ts
threshold?: number;
```

Defined in: [src/context-manager/strategies/offload/base.ts:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L56)

**`Experimental`**

Token threshold above which individual blocks are offloaded.

---

### utilization?

```ts
utilization?: number;
```

Defined in: [src/context-manager/strategies/offload/base.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L59)

**`Experimental`**

Context utilization ratio (0-1+) above which the strategy fires.

---

### preserveRecent?

```ts
preserveRecent?: number;
```

Defined in: [src/context-manager/strategies/offload/base.ts:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/base.ts#L66)

**`Experimental`**

How many recent matching messages to leave untouched.

-   Integer (1 or above): absolute count of messages to preserve.
-   Decimal (between 0 and 1 exclusive): ratio of matching messages to preserve (e.g. 0.7 = keep 70%).