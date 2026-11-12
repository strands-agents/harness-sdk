Defined in: [src/types/messages.ts:71](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L71)

A message in a conversation between user and assistant. Each message has a role (user or assistant) and an array of content blocks.

## Implements

-   `JSONSerializable`<[`MessageData`](/docs/api/typescript/MessageData/index.md)\>

## Constructors

### Constructor

```ts
new Message(data): Message;
```

Defined in: [src/types/messages.ts:102](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L102)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | { `role`: [`Role`](/docs/api/typescript/Role/index.md); `content`: [`ContentBlock`](/docs/api/typescript/ContentBlock/index.md)\[\]; `trackingId?`: `string`; `metadata?`: `MessageMetadata`; } |
| `data.role` | [`Role`](/docs/api/typescript/Role/index.md) |
| `data.content` | [`ContentBlock`](/docs/api/typescript/ContentBlock/index.md)\[\] |
| `data.trackingId?` | `string` |
| `data.metadata?` | `MessageMetadata` |

#### Returns

`Message`

## Properties

### type

```ts
readonly type: "message";
```

Defined in: [src/types/messages.ts:75](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L75)

Discriminator for message type.

---

### role

```ts
readonly role: Role;
```

Defined in: [src/types/messages.ts:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L80)

The role of the message sender.

---

### content

```ts
readonly content: ContentBlock[];
```

Defined in: [src/types/messages.ts:85](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L85)

Array of content blocks that make up this message.

---

### trackingId

```ts
readonly trackingId: string;
```

Defined in: [src/types/messages.ts:95](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L95)

Durable, stable UUID for the message, assigned at construction. Every Message has one — a caller-supplied id is preserved, otherwise a fresh UUID is minted (so callers do not normally set it; a caller supplying its own should use a UUID v4, e.g. `crypto.randomUUID()`). Survives session save/restore, and is stripped before model calls. Preserved when a message is copied or restored, so ids are unique within a conversation, but the same message carries the same id across sessions (copying another agent’s messages does not re-key them).

---

### metadata?

```ts
metadata?: MessageMetadata;
```

Defined in: [src/types/messages.ts:100](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L100)

Optional metadata, not sent to model providers.

## Methods

### fromMessageData()

```ts
static fromMessageData(data): Message;
```

Defined in: [src/types/messages.ts:120](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L120)

Creates a Message instance from MessageData. Use [Message.fromJSON](#fromjson) for data [Message.toJSON](#tojson) produced.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | [`MessageData`](/docs/api/typescript/MessageData/index.md) | MessageData to convert |

#### Returns

`Message`

Message instance

#### Throws

Error if a content block type, at any depth, is unknown

---

### toJSON()

```ts
toJSON(): MessageData;
```

Defined in: [src/types/messages.ts:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L138)

Serializes the Message to a JSON-compatible MessageData object. Called automatically by JSON.stringify().

#### Returns

[`MessageData`](/docs/api/typescript/MessageData/index.md)

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): Message;
```

Defined in: [src/types/messages.ts:155](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L155)

Creates a Message from data [Message.toJSON](#tojson) produced, such as a saved session. Unlike [Message.fromMessageData](#frommessagedata), it keeps a content block of a type this version does not recognize, also inside a tool result, as an [UnknownBlock](/docs/api/typescript/UnknownBlock/index.md), so data a newer SDK version saved still loads.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | [`MessageData`](/docs/api/typescript/MessageData/index.md) | MessageData to deserialize |

#### Returns

`Message`

Message instance

---

### clone()

```ts
clone(): Message;
```

Defined in: [src/types/messages.ts:162](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L162)

Creates a deep copy of this Message (round-trips through serialization).

#### Returns

`Message`

---

### with()

```ts
with(overrides): Message;
```

Defined in: [src/types/messages.ts:178](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L178)

**`Experimental`**

A shallow copy of this message with the given content or metadata in place of its own. The copy keeps this message’s role and tracking id, and shares its blocks. A field left out, or set to `undefined`, keeps this message’s value.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `overrides` | { `content?`: [`ContentBlock`](/docs/api/typescript/ContentBlock/index.md)\[\]; `metadata?`: `MessageMetadata`; } | The content or metadata of the copy |
| `overrides.content?` | [`ContentBlock`](/docs/api/typescript/ContentBlock/index.md)\[\] | \- |
| `overrides.metadata?` | `MessageMetadata` | \- |

#### Returns

`Message`

The copy