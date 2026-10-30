```ts
type InterruptSource = "tool" | "hook" | "middleware" | "multiagent-hook";
```

Defined in: [src/interrupt.ts:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L24)

Origin of an interrupt:

-   `'tool'` — raised by a tool callback via `ToolContext.interrupt()`.
-   `'hook'` — raised by an agent-level hook (e.g. `BeforeToolCallEvent.interrupt()`).
-   `'multiagent-hook'` — raised by a multi-agent hook (e.g. `BeforeNodeCallEvent.interrupt()`).