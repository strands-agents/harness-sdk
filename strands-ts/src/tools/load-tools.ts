import { z } from 'zod'
import { ToolReferenceBlock } from '../types/messages.js'
import { tool } from './tool-factory.js'
import type { LocalAgent } from '../types/agent.js'
import type { Tool } from './tool.js'

/** Name of the tool a model calls to load the input schemas of deferred tools. */
export const LOAD_TOOLS_TOOL_NAME = 'load_tools'

/** The loaders {@link createLoadTools} made, told apart from a user's tool of the same name by identity. */
const LOADERS = new WeakSet<Tool>()

/**
 * Whether a tool is the SDK's `load_tools`, rather than a user's tool with that name.
 *
 * @param tool - The tool to check
 * @returns Whether {@link createLoadTools} made the tool
 * @internal
 */
export function isLoadTools(tool: Tool | undefined): boolean {
  return tool !== undefined && LOADERS.has(tool)
}

/**
 * Creates the tool a model calls to load deferred tools. It returns one {@link ToolReferenceBlock} per tool and
 * nothing else, since the Claude API rejects a tool result that mixes tool references with other content. A name that
 * isn't a deferred tool fails the whole call, so the model can call again with the right names.
 *
 * @param deferredTools - Returns the names of the agent's deferred tools
 * @returns The `load_tools` tool
 * @internal
 */
export function createLoadTools(deferredTools: (agent: LocalAgent) => readonly string[]): Tool {
  const loader = tool({
    name: LOAD_TOOLS_TOOL_NAME,
    description:
      'Load tools whose parameters are not shown yet, so you can call them. Load every tool you need in one call.',
    inputSchema: z.object({ names: z.array(z.string()).min(1).describe('Names of the tools to load.') }),
    callback: (input, context) => {
      const agent = context!.agent
      const deferred = new Set(deferredTools(agent))
      const names = [...new Set(input.names)]
      const missing = names.filter((name) => !agent.toolRegistry.get(name))
      const shown = names.filter((name) => !deferred.has(name) && agent.toolRegistry.get(name))
      // One bad name loads none: a result that mixes references with text loses Claude's native references.
      if (missing.length > 0 || shown.length > 0) throw new Error(nothingLoaded(missing, shown))
      return names.map((name) => new ToolReferenceBlock({ name }))
    },
  })
  LOADERS.add(loader)
  return loader
}

/** Why a load loaded nothing, naming each tool it couldn't load and what to do instead. */
function nothingLoaded(missing: readonly string[], shown: readonly string[]): string {
  const reasons: string[] = []
  if (shown.length > 0) {
    reasons.push(namesWith(shown, 'is shown in full, so call it directly', 'are shown in full, so call them directly'))
  }
  if (missing.length > 0) reasons.push(namesWith(missing, 'is not a tool', 'are not tools'))
  return `Nothing loaded: ${reasons.join('; ')}. Load only tools whose parameters are not shown.`
}

/** The names, followed by the phrase that agrees with how many there are. */
function namesWith(names: readonly string[], one: string, many: string): string {
  return `${names.join(', ')} ${names.length === 1 ? one : many}`
}
