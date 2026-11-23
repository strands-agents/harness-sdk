```ts
type ContextManagerStrategy =
  | ContextManagerPreset
  | ContextManagerConfig
  | ContextManager
  | false;
```

Defined in: [src/context-manager/context-manager.ts:72](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/context-manager.ts#L72)

Supported values for the `contextManager` parameter.

-   `"auto"`: Managed context with proactive compression + offloading.
-   `"agentic"`: (Experimental) Model-driven context management via injected tools. This mode may change in future versions.
-   [ContextManagerConfig](/docs/api/typescript/ContextManagerConfig/index.md): Custom strategy pipeline and archive configuration.
-   [ContextManager](/docs/api/typescript/ContextManager/index.md): A pre-built instance, used as-is. An instance binds to one agent; construct one per `Agent`.
-   `false`: Explicitly disable all context management (no compression, no offloading).