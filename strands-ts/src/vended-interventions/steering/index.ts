/**
 * Steering system for Strands agents.
 *
 * Provides contextual guidance for agents through modular prompting.
 * Instead of front-loading all instructions, steering handlers provide
 * just-in-time feedback based on context data from registered providers.
 *
 * Steering handlers are {@link InterventionHandler}s — register them on the
 * agent via the `interventions:` option, not `plugins:`.
 *
 * Core components:
 * - SteeringHandler: base class for guidance logic
 * - SteeringContextProvider: interface for context data providers
 *
 * Handler implementations:
 * - LLMSteeringHandler: an LLM decides and writes the guidance
 * - DecisionModelSteeringHandler: a DecisionModel decides; guidance is fixed, computed, or LLM-written
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { LLMSteeringHandler } from '@strands-agents/sdk/vended-interventions/steering'
 *
 * const handler = new LLMSteeringHandler({
 *   systemPrompt: '...',
 *   model: new BedrockModel(),
 * })
 * const agent = new Agent({ tools: [...], interventions: [handler] })
 * ```
 */

// Core
export type { SteeringContextData, SteeringContextProvider } from './providers/context-provider.js'
export { SteeringHandler, type SteeringHandlerConfig } from './handlers/handler.js'

// Context providers
export { ToolLedgerProvider, type ToolLedgerProviderConfig } from './providers/tool-ledger.js'

// Handler implementations
export { LLMSteeringHandler, type LLMSteeringHandlerConfig, type PromptBuilder } from './handlers/llm.js'
export {
  DecisionModelSteeringHandler,
  type DecisionModelSteeringHandlerConfig,
  type GuidanceBuilder,
  type GuidanceInput,
} from './handlers/decision-model.js'
