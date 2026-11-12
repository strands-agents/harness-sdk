import { z } from 'zod'
import { ToolReferenceBlock } from '../types/messages.js'
import { tool } from './tool-factory.js'
import type { LocalAgent } from '../types/agent.js'
import type { Tool } from './tool.js'

/** Name of the tool a model calls to load the input schemas of deferred tools. */
export const LOAD_TOOLS_TOOL_NAME = 'strands_load_tools'

/**
 * Creates the tool a model calls to load deferred tools. It returns one {@link ToolReferenceBlock} per tool and
 * nothing else, since the Claude API rejects a tool result that mixes tool references with other content. A name that
 * isn't a deferred tool fails the whole call, so the model can call again with the right names.
 *
 * @param deferredTools - Returns the names of the agent's deferred tools
 * @returns The `strands_load_tools` tool
 * @internal
 */
export function createLoadTools(deferredTools: (agent: LocalAgent) => readonly string[]): Tool {
  return tool({
    name: LOAD_TOOLS_TOOL_NAME,
    description:
      'Load tools whose parameters are not shown yet, so you can call them. Load every tool you need in one call.',
    inputSchema: z.object({ names: z.array(z.string()).min(1).describe('Names of the tools to load.') }),
    callback: (input, context) => {
      const agent = context!.agent
      const deferred = new Set(deferredTools(agent))
      const names = [...new Set(input.names)]
      const unknown = names.filter((name) => !deferred.has(name) || !agent.toolRegistry.get(name))
      if (unknown.length > 0) {
        const subject = unknown.length === 1 ? 'is not a deferred tool' : 'are not deferred tools'
        throw new Error(
          `Nothing loaded: ${unknown.join(', ')} ${subject}. Load only tools whose parameters are not shown.`
        )
      }
      return names.map((name) => new ToolReferenceBlock({ name }))
    },
  })
}
