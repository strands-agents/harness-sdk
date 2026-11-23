Defined in: [src/tools/function-tool.ts:61](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L61)

Configuration options for creating a FunctionTool.

## Properties

### name

```ts
name: string;
```

Defined in: [src/tools/function-tool.ts:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L63)

The unique name of the tool

---

### description

```ts
description: string;
```

Defined in: [src/tools/function-tool.ts:65](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L65)

Human-readable description of the tool’s purpose

---

### inputSchema?

```ts
inputSchema?: JSONSchema7;
```

Defined in: [src/tools/function-tool.ts:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L67)

JSON Schema defining the expected input structure. If omitted, defaults to an empty object schema.

---

### callback

```ts
callback: FunctionToolCallback;
```

Defined in: [src/tools/function-tool.ts:69](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L69)

Function that implements the tool logic