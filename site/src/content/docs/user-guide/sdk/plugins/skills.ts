import { Agent } from '@strands-agents/sdk'
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'

declare const model: any

// =====================
// Usage Example
// =====================

{
  // --8<-- [start:usage]
  // Single skill directory
  const plugin = new AgentSkills({
    skills: ['./skills/pdf-processing'],
  })

  // Parent directory loads all child directories
  // containing SKILL.md
  const pluginFromDir = new AgentSkills({
    skills: ['./skills/'],
  })

  // Mixed sources
  const pluginMixed = new AgentSkills({
    skills: [
      './skills/pdf-processing',
      './skills/',
      new Skill({
        name: 'custom-greeting',
        description: 'Generate custom greetings',
        instructions: 'Always greet the user by name with enthusiasm.',
      }),
    ],
  })

  const agent = new Agent({
    model,
    plugins: [pluginMixed],
  })
  // --8<-- [end:usage]

  void plugin
  void pluginFromDir
  void agent
}

// =====================
// Tools for Resource Access
// =====================

{
  // --8<-- [start:tools]
  const plugin = new AgentSkills({
    skills: ['./skills/'],
  })

  const agent = new Agent({
    model,
    plugins: [plugin],
    tools: [bash, fileEditor],
  })
  // --8<-- [end:tools]

  void agent
}

// =====================
// Programmatic Skill Creation
// =====================

{
  // --8<-- [start:programmatic]
  // Create directly
  const skill = new Skill({
    name: 'code-review',
    description: 'Review code for best practices and bugs',
    instructions: 'Review the provided code. Check for...',
  })

  // Parse from SKILL.md content
  const parsed = Skill.fromContent(
    '---\n' +
      'name: code-review\n' +
      'description: Review code for best practices\n' +
      '---\n' +
      'Review the provided code. Check for...\n'
  )

  // Load from a specific directory
  const loaded = Skill.fromFile('./skills/code-review')

  // Load all skills from a parent directory
  const skills = Skill.fromDirectory('./skills/')
  // --8<-- [end:programmatic]

  void skill
  void parsed
  void loaded
  void skills
}

// =====================
// Managing Skills at Runtime
// =====================

async function runtimeExample() {
  // --8<-- [start:runtime]
  const plugin = new AgentSkills({
    skills: ['./skills/pdf-processing'],
  })
  const agent = new Agent({ model, plugins: [plugin] })

  // View available skills
  const available = await plugin.getAvailableSkills()
  for (const skill of available) {
    console.log(`${skill.name}: ${skill.description}`)
  }

  // Add a new skill at runtime
  const newSkill = new Skill({
    name: 'summarize',
    description: 'Summarize long documents',
    instructions: 'Read the document and produce a concise summary...',
  })
  plugin.setAvailableSkills([...available, newSkill])

  // Replace all skills
  plugin.setAvailableSkills(['./skills/new-set/'])

  // Check which skills the agent has activated
  const activated = plugin.getActivatedSkills(agent)
  console.log(`Activated skills: ${activated}`)
  // --8<-- [end:runtime]
}

void runtimeExample
