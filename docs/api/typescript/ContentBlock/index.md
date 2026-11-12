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
  | SummaryBlock
  | UnknownBlock;
```

Defined in: [src/types/messages.ts:223](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L223)