Defined in: [src/context-manager/strategies/offload/conditions.ts:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/conditions.ts#L41)

**`Experimental`**

Conditions that determine when and how an offload strategy fires.

-   `contextUtilization` sets when the strategy fires. `'80%'` fires at 80% of the context window; a whole number of 1,000 or more fires at that many conversation tokens, and throws if it exceeds the model’s context window.
-   `blockThreshold` sets how large each block, or each message for target `'*'`, must be to act on. A whole number selects content larger than that many tokens; `'5%'` selects content larger than 5% of the context window (10,000 tokens of a 200,000-token window).
-   `preserveRecent` sets which matching messages it never touches. A whole number keeps that many of the newest; `'70%'` keeps the newest 70% of them.

With no `contextUtilization`, the strategy runs before every model call, or on each message as it arrives when the target isn’t `'*'` and `preserveRecent` is unset or 0. `blockThreshold` doesn’t change when it runs.

Granularity: target `'*'` acts on whole messages, and `blockThreshold` measures each message. Drop removes them, summarize merges each contiguous run, and truncate elides the middle and doesn’t take a `blockThreshold`. Any other target acts on each block, and `blockThreshold` measures each block. `contextUtilization` only gates when the strategy fires, and `preserveRecent` only protects the newest matching messages.

Strategies run as an ordered pipeline, so once an earlier strategy shrinks a block, it falls below the next strategy’s threshold and gets skipped.

## Properties

### contextUtilization?

```ts
contextUtilization?: number | `${number}%`;
```

Defined in: [src/context-manager/strategies/offload/conditions.ts:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/conditions.ts#L46)

**`Experimental`**

Context usage at or above which the strategy fires: `'80%'` of the context window, or a whole number of 1,000 or more for conversation tokens, at most the model’s context window.

---

### blockThreshold?

```ts
blockThreshold?: number | `${number}%`;
```

Defined in: [src/context-manager/strategies/offload/conditions.ts:53](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/conditions.ts#L53)

**`Experimental`**

Size above which a message (target `'*'`) or block is offloaded: a whole number of tokens above 0, or `'5%'` of the context window. Unset, there is no size check. Media the token count measures as 0, alone or in a tool result, always passes.

---

### preserveRecent?

```ts
preserveRecent?: number | `${number}%`;
```

Defined in: [src/context-manager/strategies/offload/conditions.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/conditions.ts#L59)

**`Experimental`**

Newest matching messages never touched: a count, or `'70%'` of the matches, rounded up so a share above 0 keeps at least one.