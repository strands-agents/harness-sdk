/**
 * The developer's agent builder. Every scenario calls `createAgent(...)` to
 * get its agent — so THIS FILE is where you wire in your experiment. You have
 * full control over how the agent is constructed: model, conversation manager,
 * plugins, retry strategy, whatever you're testing. The only requirement is
 * that the profiler plugin is included (it's passed to you).
 *
 * Scenarios tell you what they need via `AgentRequirements` — the tools and
 * system prompt that make the scenario work, plus a suggested window size for
 * scenarios that stress context management. You can honor or ignore the
 * suggestion (that's the point — you're experimenting).
 */

import { Agent } from '../../../strands-ts/src/agent/agent.js'
import { BedrockModel } from '../../../strands-ts/src/models/bedrock.js'
import { SlidingWindowConversationManager } from '../../../strands-ts/src/conversation-manager/sliding-window-conversation-manager.js'
import type { Tool } from '../../../strands-ts/src/tools/tool.js'
import type { ProfilerObserver } from './observer.js'

export interface AgentRequirements {
  systemPrompt: string
  tools: Tool[]
  /** Suggested window size for scenarios that stress context management.
   *  You can use it, ignore it, or substitute your own manager entirely. */
  windowSize?: number
}

/**
 * ============================================================
 * EDIT THIS FUNCTION to wire in your experiment.
 * ============================================================
 *
 * You own the full Agent construction. Change the model, swap the
 * conversation manager, add plugins, adjust retry — whatever you're
 * A/B testing. The only rule: include `profiler` in `plugins` so
 * the profiler can observe.
 *
 * Example — testing a custom conversation manager:
 *
 *   return new Agent({
 *     model: 'us.anthropic.claude-sonnet-4-6',
 *     systemPrompt: req.systemPrompt,
 *     tools: req.tools,
 *     conversationManager: new MyCustomManager({ maxTokens: 8000 }),
 *     plugins: [profiler, new MyPlugin()],
 *     printer: false,
 *   })
 * ============================================================
 */
export function createAgent(profiler: ProfilerObserver, req: AgentRequirements): Agent {
  return new Agent({
    model: new BedrockModel({
      modelId: 'us.anthropic.claude-sonnet-4-6',
      cacheConfig: { strategy: 'auto' },
    }),
    systemPrompt: req.systemPrompt,
    tools: req.tools,
    conversationManager: req.windowSize
      ? new SlidingWindowConversationManager({ windowSize: req.windowSize })
      : undefined,
    plugins: [profiler],
    printer: false,
  })
}
