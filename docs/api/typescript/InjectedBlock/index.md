Defined in: [src/types/messages.ts:1265](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1265)

Text the app adds to a user turn, such as a reminder, kept apart from the user’s own words so readers of `agent.messages` can skip it. `ContextInjector` writes its text as injected blocks. It belongs in a user message, after the existing content; in any other message it is left out.

When the model takes temporary messages (`modelInfo.capabilities.temporaryMessages`), the provider sends it as a system message the model reads only until the next user message, which the model ranks above the user. Every other model receives only the latest user message’s injected text, as plain text. Keep content from outside the conversation, such as tool output or retrieved documents, out of it.

The text is kept under `injected`, the same shape as the saved data, so an InjectedBlock is never read as a [TextBlock](/docs/api/typescript/TextBlock/index.md).

## Example

```typescript
const message = new Message({
  role: 'user',
  content: [new TextBlock('Refactor the tokenizer.'), new InjectedBlock({ text: 'cwd: /repo', source: 'env' })],
})
```

## Implements

-   `JSONSerializable`<{ `injected`: [`InjectedBlockData`](/docs/api/typescript/InjectedBlockData/index.md); }>

## Constructors

### Constructor

```ts
new InjectedBlock(data): InjectedBlock;
```

Defined in: [src/types/messages.ts:1276](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1276)

#### Parameters

| Parameter | Type |
| --- | --- |
| `data` | [`InjectedBlockData`](/docs/api/typescript/InjectedBlockData/index.md) |

#### Returns

`InjectedBlock`

## Properties

### type

```ts
readonly type: "injectedBlock";
```

Defined in: [src/types/messages.ts:1269](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1269)

Discriminator for injected content.

---

### injected

```ts
readonly injected: InjectedBlockData;
```

Defined in: [src/types/messages.ts:1274](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1274)

The injected data: the text the app adds to the user turn and the component that added it.

## Methods

### toJSON()

```ts
toJSON(): {
  injected: InjectedBlockData;
};
```

Defined in: [src/types/messages.ts:1284](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1284)

Serializes the InjectedBlock to a JSON-compatible ContentBlockData object. Called automatically by JSON.stringify().

#### Returns

```ts
{
  injected: InjectedBlockData;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `injected` | [`InjectedBlockData`](/docs/api/typescript/InjectedBlockData/index.md) | [src/types/messages.ts:1284](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1284) |

#### Implementation of

`JSONSerializable.toJSON`

---

### fromJSON()

```ts
static fromJSON(data): InjectedBlock;
```

Defined in: [src/types/messages.ts:1294](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L1294)

Creates an InjectedBlock instance from its wrapped data format.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `data` | { `injected`: [`InjectedBlockData`](/docs/api/typescript/InjectedBlockData/index.md); } | Wrapped InjectedBlockData to deserialize |
| `data.injected` | [`InjectedBlockData`](/docs/api/typescript/InjectedBlockData/index.md) | \- |

#### Returns

`InjectedBlock`

InjectedBlock instance