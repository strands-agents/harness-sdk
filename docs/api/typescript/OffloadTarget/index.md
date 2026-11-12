```ts
type OffloadTarget =
  | "*"
  | "toolResults"
  | "toolResultErrors"
  | "assistantText"
  | "userText"
  | "media"
  | string[];
```

Defined in: [src/context-manager/strategies/offload/target.ts:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/context-manager/strategies/offload/target.ts#L31)

**`Experimental`**

Target for offload operations. This union is intentionally extensible — new string-literal members can be added freely as new content categories emerge.

-   `"toolResults"` — all successful tool result blocks
-   `"toolResultErrors"` — all failed tool result blocks
-   `"assistantText"` — text blocks in assistant messages
-   `"userText"` — text blocks in user messages (excluding tool results)
-   `"media"` — image, document, video, and audio blocks outside tool results
-   `string[]` — tool results from tools to include (e.g. `['bash']` or `['tool::bash']`) and, prefixed with `!`, tools to exclude. A list of only exclusions acts on every other tool.
-   `"*"` — whole messages