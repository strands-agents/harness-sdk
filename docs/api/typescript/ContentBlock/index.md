```ts
type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ReasoningBlock
  | CachePointBlock
  | GuardContentBlock
  | AudioBlock
  | ImageBlock
  | VideoBlock
  | DocumentBlock
  | CitationsBlock
  | InjectedBlock
  | SummaryBlock;
```

Defined in: [src/types/messages.ts:193](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L193)