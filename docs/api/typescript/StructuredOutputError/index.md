Defined in: [src/errors.ts:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L249)

Thrown when the model fails to produce structured output. This occurs when the LLM refuses to use the structured output tool even after being forced via toolChoice.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new StructuredOutputError(message): StructuredOutputError;
```

Defined in: [src/errors.ts:250](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/errors.ts#L250)

#### Parameters

| Parameter | Type |
| --- | --- |
| `message` | `string` |

#### Returns

`StructuredOutputError`

#### Overrides

`Error.constructor`