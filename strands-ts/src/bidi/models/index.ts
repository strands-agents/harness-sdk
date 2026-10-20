/**
 * Bidirectional model interfaces and configuration types.
 */

export { BedrockNovaSonicModel } from './bedrock.js'
export type { BedrockNovaSonicModelConfig, BedrockNovaSonicModelOptions } from './bedrock.js'

export { BidiModel, ConnectionTimeoutError, isAudioCapable, isRestartable } from './model.js'
export type { AudioCapable, BidiModelStartOptions, Restartable } from './model.js'

export { OpenAIRealtimeModel } from './openai.js'
export type { OpenAIRealtimeModelConfig, OpenAIRealtimeModelOptions } from './openai.js'

export type {
  AudioConfig,
  AudioStreamConfig,
  BedrockNovaSonicAudioConfig,
  BedrockNovaSonicAudioStreamConfig,
  BidiModelConfig,
  ConnectionConfig,
  GoogleGeminiLiveAudioConfig,
  GoogleGeminiLiveAudioStreamConfig,
} from './configs.js'

// GoogleGeminiLiveModel is intentionally omitted: it statically imports the optional peer
// `@google/genai`, so it ships on the `@strands-agents/sdk/bidi/models/google` subpath instead.
