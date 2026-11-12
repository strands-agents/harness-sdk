```ts
type ContextManagerStrategy =
  | ContextManagerPreset
  | ContextManagerConfig
  | ContextManager
  | false;
```

Defined in: [src/context-manager/context-manager.ts:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L67)

Supported values for the `contextManager` parameter.

-   `"auto"`: Managed context with proactive compression + offloading.
-   `"agentic"`: Model-driven context management via injected tools.
-   [ContextManagerConfig](/docs/api/typescript/ContextManagerConfig/index.md): Custom strategy pipeline and stash configuration.
-   ContextManager: A pre-built instance, used as-is. An instance binds to one agent; construct one per `Agent`.
-   `false`: Explicitly disable all context management (no compression, no offloading).