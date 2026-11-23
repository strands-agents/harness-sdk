Defined in: [src/tools/function-tool.ts:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L101)

A Tool implementation that wraps a callback function and handles all ToolResultBlock conversion.

FunctionTool allows creating tools from existing functions without needing to manually handle ToolResultBlock formatting or error handling. It supports multiple callback patterns:

-   Async generators for streaming responses
-   Promises for async operations
-   Synchronous functions for immediate results

All return values are automatically wrapped in ToolResultBlock, and errors are caught and returned as error ToolResultBlocks.

## Example

```typescript
// Create a tool with streaming
const streamingTool = new FunctionTool({
  name: 'processor',
  description: 'Processes data with progress updates',
  inputSchema: { type: 'object', properties: { data: { type: 'string' } } },
  callback: async function* (input: any) {
    yield 'Starting processing...'
    // Do some work
    yield 'Halfway done...'
    // More work
    return 'Processing complete!'
  }
})
```

## Extends

-   [`Tool`](/docs/api/typescript/Tool/index.md)

## Implements

-   [`InvokableTool`](/docs/api/typescript/InvokableTool/index.md)<`unknown`, [`JSONValue`](/docs/api/typescript/JSONValue/index.md)\>

## Constructors

### Constructor

```ts
new FunctionTool(config): FunctionTool;
```

Defined in: [src/tools/function-tool.ts:149](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L149)

Creates a new FunctionTool instance.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `config` | [`FunctionToolConfig`](/docs/api/typescript/FunctionToolConfig/index.md) | Configuration object for the tool |

#### Returns

`FunctionTool`

#### Example

```typescript
// Tool with input schema
const greetTool = new FunctionTool({
  name: 'greeter',
  description: 'Greets a person by name',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  },
  callback: (input: any) => `Hello, ${input.name}!`
})

// Tool without input (no parameters)
const statusTool = new FunctionTool({
  name: 'getStatus',
  description: 'Gets system status',
  callback: () => ({ status: 'operational' })
})
```

#### Overrides

[`Tool`](/docs/api/typescript/Tool/index.md).[`constructor`](/docs/api/typescript/Tool/index.md#constructor)

## Properties

### name

```ts
readonly name: string;
```

Defined in: [src/tools/function-tool.ts:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L105)

The unique name of the tool.

#### Implementation of

[`InvokableTool`](/docs/api/typescript/InvokableTool/index.md).[`name`](/docs/api/typescript/InvokableTool/index.md#name)

#### Overrides

[`Tool`](/docs/api/typescript/Tool/index.md).[`name`](/docs/api/typescript/Tool/index.md#name)

---

### description

```ts
readonly description: string;
```

Defined in: [src/tools/function-tool.ts:110](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L110)

Human-readable description of what the tool does.

#### Implementation of

[`InvokableTool`](/docs/api/typescript/InvokableTool/index.md).[`description`](/docs/api/typescript/InvokableTool/index.md#description)

#### Overrides

[`Tool`](/docs/api/typescript/Tool/index.md).[`description`](/docs/api/typescript/Tool/index.md#description)

---

### toolSpec

```ts
readonly toolSpec: ToolSpec;
```

Defined in: [src/tools/function-tool.ts:115](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L115)

OpenAPI JSON specification for the tool.

#### Implementation of

[`InvokableTool`](/docs/api/typescript/InvokableTool/index.md).[`toolSpec`](/docs/api/typescript/InvokableTool/index.md#toolspec)

#### Overrides

[`Tool`](/docs/api/typescript/Tool/index.md).[`toolSpec`](/docs/api/typescript/Tool/index.md#toolspec)

## Methods

### stream()

```ts
stream(toolContext): AsyncGenerator<ToolStreamEvent, ToolResultBlock, unknown>;
```

Defined in: [src/tools/function-tool.ts:176](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L176)

Executes the tool with streaming support. Handles all callback patterns (async generator, promise, sync) and converts results to ToolResultBlock.

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `toolContext` | [`ToolContext`](/docs/api/typescript/ToolContext/index.md) | Context information including the tool use request and invocation state |

#### Returns

`AsyncGenerator`<[`ToolStreamEvent`](/docs/api/typescript/ToolStreamEvent/index.md), [`ToolResultBlock`](/docs/api/typescript/ToolResultBlock/index.md), `unknown`\>

Async generator that yields ToolStreamEvents and returns a ToolResultBlock

#### Implementation of

[`InvokableTool`](/docs/api/typescript/InvokableTool/index.md).[`stream`](/docs/api/typescript/InvokableTool/index.md#stream)

#### Overrides

[`Tool`](/docs/api/typescript/Tool/index.md).[`stream`](/docs/api/typescript/Tool/index.md#stream)

---

### invoke()

```ts
invoke(input, context?): Promise<JSONValue>;
```

Defined in: [src/tools/function-tool.ts:230](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/function-tool.ts#L230)

Invokes the tool directly with raw input and returns the unwrapped result.

Unlike stream(), this method:

-   Returns the raw result (not wrapped in ToolResult)
-   Consumes async generators and returns the generator’s return value
-   Lets errors throw naturally (not wrapped in error ToolResult)

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `input` | `unknown` | The input parameters for the tool |
| `context?` | [`ToolContext`](/docs/api/typescript/ToolContext/index.md) | Optional tool execution context |

#### Returns

`Promise`<[`JSONValue`](/docs/api/typescript/JSONValue/index.md)\>

The unwrapped result

#### Implementation of

[`InvokableTool`](/docs/api/typescript/InvokableTool/index.md).[`invoke`](/docs/api/typescript/InvokableTool/index.md#invoke)