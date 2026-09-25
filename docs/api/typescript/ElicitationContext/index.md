```ts
type ElicitationContext = ClientContext & {
  signal: AbortSignal;
};
```

Defined in: [src/types/elicitation.ts:7](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/elicitation.ts#L7)

Context provided to an elicitation callback. The abort signal for the in-flight request is available at `context.mcpReq.signal`.

## Type Declaration

| Name | Type | Description | Defined in |
| --- | --- | --- | --- |
| `signal` | `AbortSignal` | Abort signal for the in-flight request. **Deprecated** Read `context.mcpReq.signal` instead. | [src/types/elicitation.ts:13](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/elicitation.ts#L13) |