Defined in: [src/errors.ts:104](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L104)

Error thrown when attempting to invoke an agent that is already processing an invocation.

This error indicates that invoke() or stream() was called while the agent is already executing. Agents can only process one invocation at a time to prevent state corruption.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new ConcurrentInvocationError(message): ConcurrentInvocationError;
```

Defined in: [src/errors.ts:110](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L110)

Creates a new ConcurrentInvocationError.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `message` | `string` | Error message describing the concurrent invocation attempt |

#### Returns

`ConcurrentInvocationError`

#### Overrides

`Error.constructor`