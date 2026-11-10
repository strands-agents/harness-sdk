/**
 * Goal plugin for Strands Agents — iterative refinement against a validator,
 * inspired by Claude Code's `/goal` command.
 *
 * @example
 * ```ts
 * import { Agent } from '@strands-agents/sdk'
 * import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'
 *
 * const concise = new GoalLoop({
 *   goal: 'At most 3 sentences, accessible to a 10-year-old.',
 *   maxAttempts: 3,
 * })
 * const agent = new Agent({ model, plugins: [concise] })
 * await agent.invoke('Explain how rainbows form.')
 * ```
 */

export { GoalLoop } from './plugin.js'
export type {
  GoalLoopOptions,
  JudgeConfig,
  Validator,
  ValidationOutcome,
  GoalAttempt,
  GoalResult,
  GoalStopReason,
} from './plugin.js'

export { JUDGE_OUTCOME_SCHEMA, JUDGE_SYSTEM_PROMPT, buildJudgePrompt } from './judge.js'
