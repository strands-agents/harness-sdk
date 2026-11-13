import type { JSONValue } from '@strands-agents/sdk'

import type { AgentExtensionHost, AgentExtensionSkill, AgentExtensionTool } from '../agent/extension.js'
import type { ImportedAgentProject } from '../project/import.js'
import { isRecord } from '../values.js'
import type { DevWorkspace } from './workspace.js'

export interface DevChatTool extends AgentExtensionTool {
  run(input: Readonly<Record<string, JSONValue>>): Promise<string>
}

export interface DevChatPart {
  readonly instructions: string
  readonly skills: readonly AgentExtensionSkill[]
  readonly tools: readonly DevChatTool[]
}

const workspaceInstructions = (workspace: DevWorkspace, project: ImportedAgentProject): string => {
  const directory = workspace.directory ?? workspace.root
  return [
    'This chat runs inside strands dev, the local workspace where a developer builds, tests, and improves this agent.',
    'The person in this chat is that developer, so you can talk about how you are built and how you behave.',
    'This developer workflow is a runtime-only overlay, not part of the agent being built. Do not copy its instructions, skills, or strands_dev_* tools into agent source, configuration, or exports.',
    '',
    `Agent: ${workspace.config.name} (${project.language})`,
    `Agent source: ${project.entrypoint}`,
    `Workspace folder: ${directory}`,
    '',
    'strands dev owns the workspace folder:',
    '- .config: the workspace binding (agent path, entrypoint, and language). Do not edit it.',
    '- .strands/state/: the sessions and memory of this dev chat, kept apart from the agent itself.',
    '- tmp/: generated files. tmp/initial.json names the first copy of the agent, in tmp/<id>/agent.',
    'When the developer asks you to change this agent, change the agent source and the files it loads, not the copies in tmp/.',
  ].join('\n')
}

export const devChatExtension = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  parts: readonly DevChatPart[]
): AgentExtensionHost => {
  const tools = parts.flatMap((part) => part.tools)
  const sections = [workspaceInstructions(workspace, project), ...parts.map((part) => part.instructions)]
  return {
    extension: {
      instructions: `<strands_dev>\n${sections.join('\n\n')}\n</strands_dev>`,
      skills: parts.flatMap((part) => part.skills),
      tools: tools.map(({ name, description, inputSchema, readOnly }) => ({
        name,
        description,
        inputSchema,
        ...(readOnly ? { readOnly } : {}),
      })),
    },
    call: async (name, input): Promise<string> => {
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) throw new Error(`strands dev has no tool named ${name}.`)
      return tool.run(isRecord(input) ? (input as Record<string, JSONValue>) : {})
    },
  }
}
