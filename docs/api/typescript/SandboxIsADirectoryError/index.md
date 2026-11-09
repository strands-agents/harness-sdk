Defined in: [src/sandbox/errors.ts:54](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L54)

Thrown by [Sandbox.readFile](/docs/api/typescript/Sandbox/index.md#readfile) when the path is a directory.

`code` is `'EISDIR'`, so checks written for Node fs errors also match it.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new SandboxIsADirectoryError(path, options?): SandboxIsADirectoryError;
```

Defined in: [src/sandbox/errors.ts:57](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L57)

#### Parameters

| Parameter | Type |
| --- | --- |
| `path` | `string` |
| `options?` | `ErrorOptions` |

#### Returns

`SandboxIsADirectoryError`

#### Overrides

`Error.constructor`

## Properties

### code

```ts
readonly code: "EISDIR" = 'EISDIR';
```

Defined in: [src/sandbox/errors.ts:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L55)