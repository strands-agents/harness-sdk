Defined in: [src/types/messages.ts:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L36)

Data for a message.

## Properties

### role

```ts
role: Role;
```

Defined in: [src/types/messages.ts:40](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L40)

The role of the message sender.

---

### content

```ts
content: ContentBlockData[];
```

Defined in: [src/types/messages.ts:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L45)

Array of content blocks that make up this message.

---

### trackingId?

```ts
trackingId?: string;
```

Defined in: [src/types/messages.ts:51](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L51)

Durable, stable UUID for the message. Optional here because serialized/legacy data may omit it; the Message constructor backfills a fresh UUID when absent, so a live Message always has one.

---

### metadata?

```ts
metadata?: MessageMetadata;
```

Defined in: [src/types/messages.ts:56](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L56)

Optional metadata, not sent to model providers.