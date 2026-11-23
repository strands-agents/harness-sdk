import { TextBlock, tool, type Agent, type JSONSchema, type JSONValue, type Tool } from '@strands-agents/sdk'
import { Skill, type AgentSkills, type SkillSource } from '@strands-agents/sdk/vended-plugins/skills'

export interface AgentExtensionTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JSONSchema
  readonly readOnly?: boolean
}

export interface AgentExtensionInlineSkill {
  readonly name: string
  readonly description: string
  readonly instructions: string
}

/** A skill that the skills plugin fetches from an `https://` URL to its raw SKILL.md; `name` must match its frontmatter. */
export interface AgentExtensionUrlSkill {
  readonly name: string
  readonly url: string
}

export type AgentExtensionSkill = AgentExtensionInlineSkill | AgentExtensionUrlSkill

export interface AgentExtension {
  readonly instructions: string
  readonly skills: readonly AgentExtensionSkill[]
  readonly tools: readonly AgentExtensionTool[]
}

export interface AgentExtensionHost {
  readonly extension: AgentExtension
  call(tool: string, input: JSONValue): Promise<string>
}

const settleOnCancel = (pending: Promise<string>, signal: AbortSignal | undefined): Promise<string> =>
  new Promise((resolve, reject) => {
    const cancel = (): void => reject(new Error('The tool call was cancelled.'))
    if (signal?.aborted) {
      cancel()
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    pending.then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel))
  })

export const extensionTools = ({ extension, call }: AgentExtensionHost): Tool[] =>
  extension.tools.map(({ name, description, inputSchema }) =>
    tool({
      name,
      description,
      inputSchema,
      callback: (input, context): Promise<string> =>
        settleOnCancel(call(name, input as JSONValue), context?.cancelSignal),
    })
  )

export const extensionSkills = ({ skills }: AgentExtension): SkillSource[] =>
  skills.map((skill) => ('url' in skill ? skill.url : new Skill(skill)))

export const extensionPolicies = ({ tools }: AgentExtension): string =>
  tools
    .filter(({ readOnly }) => readOnly)
    .map(({ name }) => `\npermit (\n  principal,\n  action == Action::${JSON.stringify(name)},\n  resource\n);\n`)
    .join('')

export const appendInstructions = (agent: Agent, instructions: string): void => {
  const prompt = agent.systemPrompt
  if (!instructions) return
  if (prompt === undefined || prompt === '') {
    agent.systemPrompt = instructions
  } else if (typeof prompt === 'string') {
    if (!prompt.includes(instructions)) agent.systemPrompt = `${prompt}\n\n${instructions}`
  } else if (!prompt.some((block) => block.type === 'textBlock' && block.text === instructions)) {
    agent.systemPrompt = [...prompt, new TextBlock(instructions)]
  }
}

export const addExtensionSkills = async (
  plugin: AgentSkills,
  agent: Agent,
  extension: AgentExtension
): Promise<void> => {
  const added = extensionSkills(extension)
  if (added.length === 0) return
  const names = new Set(extension.skills.map(({ name }) => name))
  const current = await plugin.getAvailableSkills(agent)
  plugin.setAvailableSkills([...current.filter(({ name }) => !names.has(name)), ...added])
}
