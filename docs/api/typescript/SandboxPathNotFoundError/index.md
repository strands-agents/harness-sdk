Defined in: [src/sandbox/errors.ts:40](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L40)

Thrown by [Sandbox.listFiles](/docs/api/typescript/Sandbox/index.md#listfiles) and [Sandbox.readFile](/docs/api/typescript/Sandbox/index.md#readfile) when the path does not exist, distinguishing genuine absence from permission failures ([SandboxPermissionError](/docs/api/typescript/SandboxPermissionError/index.md) from `readFile`) and transport failures (plain errors).

`code` is `'ENOENT'`, so checks written for Node fs errors also match it.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new SandboxPathNotFoundError(path, options?): SandboxPathNotFoundError;
```

Defined in: [src/sandbox/errors.ts:43](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L43)

#### Parameters

| Parameter | Type |
| --- | --- |
| `path` | `string` |
| `options?` | `ErrorOptions` |

#### Returns

`SandboxPathNotFoundError`

#### Overrides

`Error.constructor`

## Properties

### code

```ts
readonly code: "ENOENT" = 'ENOENT';
```

Defined in: [src/sandbox/errors.ts:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L41)