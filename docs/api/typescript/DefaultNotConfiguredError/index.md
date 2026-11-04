Defined in: [src/errors.ts:297](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L297)

Thrown when a default value is read before one has been configured.

Catch it to distinguish a missing-default condition from other runtime errors.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new DefaultNotConfiguredError(message): DefaultNotConfiguredError;
```

Defined in: [src/errors.ts:298](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L298)

#### Parameters

| Parameter | Type |
| --- | --- |
| `message` | `string` |

#### Returns

`DefaultNotConfiguredError`

#### Overrides

`Error.constructor`