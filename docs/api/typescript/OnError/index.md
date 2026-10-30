```ts
type OnError = "throw" | "proceed" | "deny";
```

Defined in: [src/interventions/handler.ts:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L21)

What to do when a handler throws during evaluation.

-   `'throw'` — rethrow the error (default, safest: a broken policy check blocks execution)
-   `'proceed'` — continue as if the handler returned Proceed. **This mode is fail-open**: a broken handler silently stops enforcing its policy. Use only when availability matters more than enforcement.
-   `'deny'` — log the error and treat it as a Deny (fail-closed)