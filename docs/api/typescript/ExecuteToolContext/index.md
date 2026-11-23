Defined in: [src/middleware/stages.ts:132](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L132)

Context passed to tool-stage middleware. Contains everything needed to understand and potentially modify the tool call.

## Extends

-   [`MiddlewareInterruptible`](/docs/api/typescript/MiddlewareInterruptible/index.md)

## Properties

### agent

```ts
readonly agent: LocalAgent;
```

Defined in: [src/middleware/stages.ts:134](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L134)

The agent instance (escape hatch for advanced use cases).

---

### tool

```ts
readonly tool: Tool;
```

Defined in: [src/middleware/stages.ts:136](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L136)

The resolved tool implementation, or undefined if not found.

---

### toolUse

```ts
readonly toolUse: ToolUseData;
```

Defined in: [src/middleware/stages.ts:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L138)

The tool use request (name, toolUseId, input).

---

### invocationState

```ts
readonly invocationState: InvocationState;
```

Defined in: [src/middleware/stages.ts:140](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L140)

Per-invocation state. Shared by reference — mutations are visible to hooks, tools, and AgentResult.

---

### cancelSignal

```ts
readonly cancelSignal: AbortSignal;
```

Defined in: [src/middleware/stages.ts:142](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L142)

Executor-owned cancellation signal for this tool call; middleware can observe but cannot replace it.

## Methods

### interrupt()

```ts
interrupt<T>(params): MiddlewareInterruptResult<T>;
```

Defined in: [src/middleware/stages.ts:52](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/middleware/stages.ts#L52)

Request a human-in-the-loop interrupt.

On first execution (no prior response), throws `InterruptError` to halt the agent. On resume (after the user provides a response), returns the response wrapped in `MiddlewareInterruptResult`.

#### Type Parameters

| Type Parameter | Default type |
| --- | --- |
| `T` | [`JSONValue`](/docs/api/typescript/JSONValue/index.md) |

#### Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `params` | [`InterruptParams`](/docs/api/typescript/InterruptParams/index.md) | Interrupt parameters (name, optional reason, optional preemptive response) |

#### Returns

[`MiddlewareInterruptResult`](/docs/api/typescript/MiddlewareInterruptResult/index.md)<`T`\>

The user’s response wrapped in `{ response: T }`

#### Throws

InterruptError when no response has been provided yet

#### Inherited from

[`MiddlewareInterruptible`](/docs/api/typescript/MiddlewareInterruptible/index.md).[`interrupt`](/docs/api/typescript/MiddlewareInterruptible/index.md#interrupt)