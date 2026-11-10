import type { Agent } from '@strands-agents/sdk'
import type { HarnessAgentOptions } from '@strands-agents/harness'

export const AGENT_DEFINITION_META_KEY = 'strands/agent-definition'

export function sessionAgentDefinitionFromMeta(
  meta: Record<string, unknown> | null | undefined
): Pick<HarnessAgentOptions, 'name' | 'description' | 'instructions'> | undefined {
  const value = meta?.[AGENT_DEFINITION_META_KEY]
  if (value === undefined) {
    return undefined
  }
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.instructions !== 'string'
  ) {
    throw new Error('Agent definition metadata is invalid.')
  }
  return {
    name: value.name,
    description: value.description,
    instructions: value.instructions,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Initializes an agent without taking a system prompt from its restored session. The CLI builds the
 * prompt from the current profile on every run; session files only supply the conversation.
 */
export async function initializeAgentDefinition(agent: Agent): Promise<void> {
  const loadSnapshot = agent.loadSnapshot
  agent.loadSnapshot = (snapshot): void => {
    const data = { ...snapshot.data }
    delete data.systemPrompt
    loadSnapshot.call(agent, { ...snapshot, data })
  }
  try {
    await agent.initialize()
  } finally {
    agent.loadSnapshot = loadSnapshot
  }
}
