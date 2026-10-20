/**
 * Bidirectional streaming for the Strands Agents TypeScript SDK.
 *
 * Bidirectional models hold a persistent connection open so audio and text flow in both
 * directions at once, instead of the request/response cycle of `Model.stream()`.
 *
 * Hook events live in the `@strands-agents/sdk/bidi/hooks` subpath: `BidiResponseStopEvent` and
 * `BidiBargeInEvent` name both an output event and a hook event, so the two sets cannot share a
 * barrel.
 *
 * `GoogleGeminiLiveModel` lives in the `@strands-agents/sdk/bidi/models/google` subpath so that
 * importing this barrel does not require the optional `@google/genai` peer dependency.
 *
 * This barrel runs in Node and browsers. Node-only I/O lives in subpaths: `ConsoleIO` in
 * `@strands-agents/sdk/bidi/io/console` and `AudioIO` in `@strands-agents/sdk/bidi/io/audio`.
 *
 * @example
 * ```typescript
 * import { BidiAgent, BedrockNovaSonicModel } from '@strands-agents/sdk/bidi'
 * import { ConsoleIO } from '@strands-agents/sdk/bidi/io/console'
 * import { BidiBargeInEvent } from '@strands-agents/sdk/bidi/hooks'
 * import { GoogleGeminiLiveModel } from '@strands-agents/sdk/bidi/models/google'
 * ```
 */

export * from './types/index.js'
export * from './models/index.js'
export * from './io/index.js'
export { BidiAgent } from './agent/agent.js'
export type { BidiAgentConfig, BidiStartOptions } from './agent/agent.js'
