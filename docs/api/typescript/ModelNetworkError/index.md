Defined in: [src/errors.ts:142](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L142)

Error thrown when the network connection to the model provider fails, before or while the response is received.

Retrying the same request may succeed. The default model retry strategy retries it, like [ModelThrottledError](/docs/api/typescript/ModelThrottledError/index.md).

## Extends

-   [`ModelError`](/docs/api/typescript/ModelError/index.md)

## Constructors

### Constructor

```ts
new ModelNetworkError(message, options?): ModelNetworkError;
```

Defined in: [src/errors.ts:149](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L149)

Creates a new ModelNetworkError.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `message` | `string` | Error message describing the network failure |
| `options?` | `ErrorOptions` | Optional error options including cause for error chaining |

#### Returns

`ModelNetworkError`

#### Overrides

[`ModelError`](/docs/api/typescript/ModelError/index.md).[`constructor`](/docs/api/typescript/ModelError/index.md#constructor)