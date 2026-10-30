Defined in: [src/interrupt.ts:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L105)

Error thrown when human input is required to continue agent execution. Caught by the agent loop to trigger an interrupt stop.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new InterruptError(interrupt): InterruptError;
```

Defined in: [src/interrupt.ts:111](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L111)

#### Parameters

| Parameter | Type |
| --- | --- |
| `interrupt` | | [`Interrupt`](/docs/api/typescript/Interrupt/index.md) | [`Interrupt`](/docs/api/typescript/Interrupt/index.md)\[\] |

#### Returns

`InterruptError`

#### Overrides

`Error.constructor`

## Properties

### interrupts

```ts
readonly interrupts: Interrupt[];
```

Defined in: [src/interrupt.ts:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interrupt.ts#L109)

The interrupts that caused this error.