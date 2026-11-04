Defined in: [src/errors.ts:310](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L310)

Error thrown when a storage operation fails.

Wraps backend-specific errors (filesystem, S3, network) with a uniform type that consumers can catch without knowing which backend is in use.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new StorageError(message, options?): StorageError;
```

Defined in: [src/errors.ts:317](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L317)

Creates a new StorageError.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `message` | `string` | Error message describing the storage failure |
| `options?` | `ErrorOptions` | Optional error options including cause for error chaining |

#### Returns

`StorageError`

#### Overrides

`Error.constructor`