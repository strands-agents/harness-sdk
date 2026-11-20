Defined in: [src/errors.ts:311](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L311)

Error thrown when a storage operation fails.

Wraps backend-specific errors (filesystem, S3, network) with a uniform type that consumers can catch without knowing which backend is in use.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new StorageError(message, options?): StorageError;
```

Defined in: [src/errors.ts:318](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L318)

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