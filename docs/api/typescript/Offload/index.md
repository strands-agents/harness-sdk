```ts
const Offload: OffloadNamespace;
```

Defined in: [src/context-manager/strategies/offload/index.ts:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/index.ts#L67)

Offload strategies — reduce content in the context window.

Target `'*'` acts on whole messages; any other target acts on each block. `blockThreshold` measures whichever the target acts on, and `contextUtilization` only gates when the strategy fires. Targets `'*'` and `'media'` need conditions from `.when()`; any other target without them acts on each matching block as it arrives, before the model reads it.

## Example

```typescript
// Per-block, eager: truncate each tool result over 1500 tokens to a 750-token preview
Offload.truncate("toolResults", { previewTokens: 750 }).when({ blockThreshold: 1500 })
// Per-block, eager: truncate specific tools' results over 5% of the context window
Offload.truncate(["tool::bash", "tool::read_file"]).when({ blockThreshold: "5%" })
// Messages: summarize the oldest messages at 70% context utilization, keeping the newest 4
Offload.summarize("*").when({ contextUtilization: "70%", preserveRecent: 4 })
// Per-block, eager: with no conditions, drop each failed tool result as it arrives. Warns on init, since a
// strategy without conditions acts on content the model has not read yet
Offload.drop("toolResultErrors")
// Per-block, gated: at 80% context utilization, drop tool results outside the newest 5 messages that hold one
Offload.drop("toolResults").when({ contextUtilization: "80%", preserveRecent: 5 })
// Per-block, gated: at 80% context utilization, drop media outside the newest message that holds any
Offload.drop("media").when({ contextUtilization: "80%", preserveRecent: 1 })
// Messages: once the window is full, drop the oldest messages, keeping the newest 70%
Offload.drop("*").when({ contextUtilization: "100%", preserveRecent: "70%" })
// Messages: at 90% context utilization, summarize messages over 2000 tokens, keeping the newest 4
Offload.summarize("*").when({ contextUtilization: "90%", blockThreshold: 2000, preserveRecent: 4 })
```