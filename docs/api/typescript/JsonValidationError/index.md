Defined in: [src/errors.ts:86](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L86)

Error thrown when attempting to serialize a value that is not JSON-serializable.

This error indicates that a value contains non-serializable types such as functions, symbols, or undefined values that cannot be converted to JSON.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new JsonValidationError(message): JsonValidationError;
```

Defined in: [src/errors.ts:92](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L92)

Creates a new JsonValidationError.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `message` | `string` | Error message describing the validation failure |

#### Returns

`JsonValidationError`

#### Overrides

`Error.constructor`