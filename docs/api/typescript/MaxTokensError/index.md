Defined in: [src/errors.ts:60](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L60)

Error thrown when the model reaches its maximum token limit during generation.

This error indicates that the model stopped generating content because it reached the maximum number of tokens allowed for the response. This is an unrecoverable state that requires intervention, such as reducing the input size or adjusting the max tokens parameter.

## Extends

-   [`ModelError`](/docs/api/typescript/ModelError/index.md)

## Constructors

### Constructor

```ts
new MaxTokensError(message, partialMessage): MaxTokensError;
```

Defined in: [src/errors.ts:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L73)

Creates a new MaxTokensError.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `message` | `string` | Error message describing the max tokens condition |
| `partialMessage` | [`Message`](/docs/api/typescript/Message/index.md) | The partial assistant message generated before the limit |

#### Returns

`MaxTokensError`

#### Overrides

[`ModelError`](/docs/api/typescript/ModelError/index.md).[`constructor`](/docs/api/typescript/ModelError/index.md#constructor)

## Properties

### partialMessage

```ts
readonly partialMessage: Message;
```

Defined in: [src/errors.ts:65](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L65)

The partial assistant message that was generated before hitting the token limit. This can be useful for understanding what the model was trying to generate.