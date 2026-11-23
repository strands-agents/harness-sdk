Defined in: [src/sandbox/errors.ts:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L28)

Thrown by sandbox execution when the abort signal fires.

`stdout` and `stderr` hold whatever the process wrote before it was killed.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new SandboxAbortError(stdout?, stderr?): SandboxAbortError;
```

Defined in: [src/sandbox/errors.ts:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L29)

#### Parameters

| Parameter | Type | Default value |
| --- | --- | --- |
| `stdout?` | `string` | `''` |
| `stderr?` | `string` | `''` |

#### Returns

`SandboxAbortError`

#### Overrides

`Error.constructor`

## Properties

### stdout

```ts
readonly stdout: string = '';
```

Defined in: [src/sandbox/errors.ts:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L30)

---

### stderr

```ts
readonly stderr: string = '';
```

Defined in: [src/sandbox/errors.ts:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L31)