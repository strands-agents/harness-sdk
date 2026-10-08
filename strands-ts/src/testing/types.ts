import type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  CachePointBlock,
  GuardContentBlock,
  JsonBlock,
  StopReason,
} from '../types/messages.js'
import type { AudioBlock, ImageBlock, VideoBlock, DocumentBlock } from '../types/media.js'
import type { CitationsBlock } from '../types/citations.js'
import type { ModelStreamEvent, Usage } from '../models/streaming.js'

/** Content blocks accepted as class instances or plain objects with a `type` discriminator. */
export type MockMessageContentBlock =
  | Omit<TextBlock, 'toJSON'>
  | Omit<ToolUseBlock, 'toJSON'>
  | Omit<ToolResultBlock, 'toJSON'>
  | Omit<ReasoningBlock, 'toJSON'>
  | Omit<CachePointBlock, 'toJSON'>
  | Omit<GuardContentBlock, 'toJSON'>
  | Omit<JsonBlock, 'toJSON'>
  | Omit<AudioBlock, 'toJSON'>
  | Omit<ImageBlock, 'toJSON'>
  | Omit<VideoBlock, 'toJSON'>
  | Omit<DocumentBlock, 'toJSON'>
  | Omit<CitationsBlock, 'toJSON'>

/** One scripted model response, or the error to throw when that turn is consumed. */
export type MockMessageTurn = MockMessageContentBlock | MockMessageContentBlock[] | Error

/** Metadata for a scripted response. */
export interface MockMessageTurnOptions {
  /** Override the inferred stop reason (`toolUse` for tool calls, otherwise `endTurn`). */
  stopReason?: StopReason
  /** Report this usage in a metadata event following the response. */
  usage?: Usage
}

/** Factory invoked once per consumed stream to provide low-level model events. */
export type ModelEventGenerator = () => AsyncGenerator<ModelStreamEvent>
