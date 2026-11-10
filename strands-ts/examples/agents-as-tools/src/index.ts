import { Agent, AgentResult, BedrockModel, tool } from '@strands-agents/sdk'
import { z } from 'zod'

/**
 * Teacher's Assistant — Agents as Tools
 *
 * An orchestrator agent routes student queries to specialized tool agents,
 * each focused on a single subject area. This mirrors the Python
 * "Teacher's Assistant" example using the agents-as-tools pattern.
 */

function extractText(result: AgentResult): string {
  return result.lastMessage.content.map((b) => ('text' in b ? b.text : '')).join('')
}

const model = new BedrockModel({ maxTokens: 1024 })

// Specialized tool agents

const mathAssistant = tool({
  name: 'math_assistant',
  description: 'Handle mathematical calculations, problems, and concepts.',
  inputSchema: z.object({
    query: z.string().describe('A math question or problem'),
  }),
  callback: async (input) => {
    const agent = new Agent({
      model,
      printer: false,
      systemPrompt: `You are a math tutor. Solve problems step-by-step and explain your reasoning clearly.`,
    })
    const result = await agent.invoke(input.query)
    return extractText(result)
  },
})

const englishAssistant = tool({
  name: 'english_assistant',
  description: 'Help with writing, grammar, literature, and composition.',
  inputSchema: z.object({
    query: z.string().describe('An English or writing question'),
  }),
  callback: async (input) => {
    const agent = new Agent({
      model,
      printer: false,
      systemPrompt: `You are an English tutor. Help with grammar, writing, literature analysis, and composition.`,
    })
    const result = await agent.invoke(input.query)
    return extractText(result)
  },
})

const computerScienceAssistant = tool({
  name: 'computer_science_assistant',
  description: 'Answer questions about programming, algorithms, and data structures.',
  inputSchema: z.object({
    query: z.string().describe('A computer science or programming question'),
  }),
  callback: async (input) => {
    const agent = new Agent({
      model,
      printer: false,
      systemPrompt: `You are a computer science tutor. Explain programming concepts, algorithms, and data structures clearly with examples.`,
    })
    const result = await agent.invoke(input.query)
    return extractText(result)
  },
})

const generalAssistant = tool({
  name: 'general_assistant',
  description: 'Handle general knowledge questions outside specialized subject areas.',
  inputSchema: z.object({
    query: z.string().describe('A general knowledge question'),
  }),
  callback: async (input) => {
    const agent = new Agent({
      model,
      printer: false,
      systemPrompt: `You are a helpful general assistant. Answer questions clearly and concisely.`,
    })
    const result = await agent.invoke(input.query)
    return extractText(result)
  },
})

// Orchestrator agent

const teacher = new Agent({
  model,
  systemPrompt: `You are TeachAssist, an educational orchestrator that routes student queries to specialists:
- Math questions → math_assistant
- Writing, grammar, literature → english_assistant
- Programming, algorithms, CS → computer_science_assistant
- Everything else → general_assistant

Always select the most appropriate tool based on the student's query.`,
  tools: [mathAssistant, englishAssistant, computerScienceAssistant, generalAssistant],
})

async function main(): Promise<void> {
  console.log("=== Teacher's Assistant — Agents as Tools ===\n")

  const response = await teacher.invoke('What is the time complexity of merge sort and why?')
  console.log('\n=== Final Response ===')
  console.log(extractText(response))
}

await main().catch(console.error)
