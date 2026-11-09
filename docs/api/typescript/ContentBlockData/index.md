```ts
type ContentBlockData =
  | TextBlockData
  | {
  toolUse: ToolUseBlockData;
}
  | {
  toolResult: ToolResultBlockData;
}
  | {
  reasoning: ReasoningBlockData;
}
  | {
  cachePoint: CachePointBlockData;
}
  | {
  guardContent: GuardContentBlockData;
}
  | {
  audio: AudioBlockData;
}
  | {
  image: ImageBlockData;
}
  | {
  video: VideoBlockData;
}
  | {
  document: DocumentBlockData;
}
  | {
  citations: CitationsBlockData;
}
  | {
  injected: InjectedBlockData;
}
  | {
  summary: SummaryBlockData;
};
```

Defined in: [src/types/messages.ts:178](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L178)

A block of content within a message. Content blocks can contain text, tool usage requests, tool results, reasoning content, cache points, guard content, citations, text the app injects, or media (audio, image, video, document).

This is a discriminated union where the object key determines the content format.

## Example

```typescript
if ('text' in block) {
  console.log(block.text.text)
}
```