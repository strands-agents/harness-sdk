Defined in: [src/sandbox/errors.ts:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L73)

Thrown by [Sandbox.readFile](/docs/api/typescript/Sandbox/index.md#readfile) when the file, or a directory above it, is not accessible.

`code` is `'EACCES'`, so checks written for Node fs errors also match it.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new SandboxPermissionError(path, options?): SandboxPermissionError;
```

Defined in: [src/sandbox/errors.ts:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L76)

#### Parameters

| Parameter | Type |
| --- | --- |
| `path` | `string` |
| `options?` | `ErrorOptions` |

#### Returns

`SandboxPermissionError`

#### Overrides

`Error.constructor`

## Properties

### code

```ts
readonly code: "EACCES" = 'EACCES';
```

Defined in: [src/sandbox/errors.ts:74](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L74)