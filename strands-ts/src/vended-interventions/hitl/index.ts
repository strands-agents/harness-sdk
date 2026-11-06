/**
 * Human-in-the-loop intervention for Strands Agents.
 *
 * Pauses agent execution before tool calls to request human approval.
 * Defaults to interrupt/resume mode for stateless deployments.
 * Pass `ask: 'stdio'` for CLI prompting or a custom `ask` function for other UIs.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
 *
 * const agent = new Agent({
 *   tools: [deleteTool, readTool],
 *   interventions: [new HumanInTheLoop({ allowedTools: ['readTool'] })],
 * })
 *
 * // Default: agent pauses with stopReason 'interrupt', caller resumes with response
 * const result = await agent.invoke('Delete the file')
 * ```
 */

export { HumanInTheLoop } from './hitl.js'
export type { HumanInTheLoopConfig } from './hitl.js'
export type { HumanInTheLoopClassifier, LlmClassifierConfig } from './classifier.js'
