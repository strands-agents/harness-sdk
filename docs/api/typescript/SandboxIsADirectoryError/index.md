Defined in: [src/sandbox/errors.ts:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L59)

Thrown by [Sandbox.readFile](/docs/api/typescript/Sandbox/index.md#readfile) when the path is a directory.

`code` is `'EISDIR'`, so checks written for Node fs errors also match it.

## Extends

-   `Error`

## Constructors

### Constructor

```ts
new SandboxIsADirectoryError(path, options?): SandboxIsADirectoryError;
```

Defined in: [src/sandbox/errors.ts:62](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L62)

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

Defined in: [src/sandbox/errors.ts:60](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/sandbox/errors.ts#L60)