Defined in: [src/background-tasks/types.ts:6](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L6)

Configures background tool execution.

## Properties

### manageToolName?

```ts
readonly manageToolName?: string;
```

Defined in: [src/background-tasks/types.ts:12](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L12)

Name of the tool the model calls to list, get, or cancel background tasks. Must not match another tool on the agent. The name is written into conversation history, so keep it stable across a saved session. Defaults to `strands_manage_background_task`.

---

### waitForCompletion?

```ts
readonly waitForCompletion?: boolean;
```

Defined in: [src/background-tasks/types.ts:14](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L14)

Wait for background work before an invocation returns. Defaults to `true`.

---

### agentic?

```ts
readonly agentic?: readonly (string | Tool)[];
```

Defined in: [src/background-tasks/types.ts:16](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L16)

Tools or registered tool names whose execution mode is selected by the model. Defaults to `['*']`.

---

### always?

```ts
readonly always?: readonly (string | Tool)[];
```

Defined in: [src/background-tasks/types.ts:18](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L18)

Tools or registered tool names that always execute in the background.

---

### never?

```ts
readonly never?: readonly (string | Tool)[];
```

Defined in: [src/background-tasks/types.ts:20](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L20)

Tools or registered tool names that never execute in the background.

---

### maxConcurrency?

```ts
readonly maxConcurrency?: number;
```

Defined in: [src/background-tasks/types.ts:22](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L22)

Maximum number of physically executing background tasks. Defaults to `4`.

---

### timeout?

```ts
readonly timeout?: number;
```

Defined in: [src/background-tasks/types.ts:24](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/background-tasks/types.ts#L24)

Per-execution timeout in milliseconds. Defaults to `Infinity`.