Defined in: [src/hooks/events.ts:478](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L478)

Response from a model invocation containing the message and stop reason.

## Properties

### message

```ts
readonly message: Message;
```

Defined in: [src/hooks/events.ts:482](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L482)

The message returned by the model.

---

### stopReason

```ts
readonly stopReason: StopReason;
```

Defined in: [src/hooks/events.ts:486](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L486)

The reason the model stopped generating.

---

### redaction?

```ts
readonly redaction?: Redaction;
```

Defined in: [src/hooks/events.ts:492](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts#L492)

Optional redaction info when guardrails blocked input. When present, indicates the last user message was redacted. The redacted message is available in `agent.messages` (last message).