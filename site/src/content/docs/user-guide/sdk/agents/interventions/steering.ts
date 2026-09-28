import { Agent, tool, InterventionActions, AfterToolCallEvent } from '@strands-agents/sdk'
import type {
  BeforeToolCallEvent,
  AfterModelCallEvent,
  LocalAgent,
} from '@strands-agents/sdk'
import {
  SteeringHandler,
  LLMSteeringHandler,
  ToolLedgerProvider,
} from '@strands-agents/sdk/vended-interventions/steering'
import type {
  SteeringContextProvider,
  SteeringContextData,
} from '@strands-agents/sdk/vended-interventions/steering'
import { z } from 'zod'

// Mock tools for examples
const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email to a recipient',
  inputSchema: z.object({
    recipient: z.string(),
    subject: z.string(),
    message: z.string(),
  }),
  callback: (input: { recipient: string; subject: string; message: string }) =>
    `Email sent to ${input.recipient}`,
})

const searchWeb = tool({
  name: 'search_web',
  description: 'Search the web for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input: { query: string }) => `Results for: ${input.query}`,
})

// =====================
// Basic Steering
// =====================

async function basicSteeringExample() {
  // --8<-- [start:basic_steering]
  class ToneSteeringHandler extends SteeringHandler {
    override readonly name = 'tone-steering'

    override beforeToolCall(event: BeforeToolCallEvent) {
      if (event.toolUse.name === 'send_email') {
        const input = event.toolUse.input as Record<string, string>
        if (input.message?.includes('URGENT') || input.message?.includes('!!!')) {
          return InterventionActions.guide(
            'Rewrite the email with a calmer, more professional tone. ' +
              'Avoid all-caps words and excessive punctuation.'
          )
        }
      }
      return InterventionActions.proceed()
    }

    override afterModelCall(_event: AfterModelCallEvent) {
      return InterventionActions.proceed()
    }
  }

  const agent = new Agent({
    tools: [sendEmail],
    interventions: [new ToneSteeringHandler()],
  })

  await agent.invoke('Send an urgent email to the team about the deadline')
  // Handler detects "URGENT" → guides agent to rewrite with calmer tone → email sends
  // --8<-- [end:basic_steering]
}

// =====================
// LLM Steering
// =====================

async function llmSteeringExample() {
  // --8<-- [start:llm_steering]
  const handler = new LLMSteeringHandler({
    systemPrompt: `
      You are providing guidance to ensure the agent follows best practices:

      Rules:
      - Emails must always include a clear subject line
      - Never send emails with aggressive or unprofessional language
      - If the same tool has failed twice in a row, suggest a different approach
      - Require human confirmation before sending emails to external domains
    `,
  })

  const agent = new Agent({
    tools: [sendEmail, searchWeb],
    interventions: [handler],
  })

  await agent.invoke('Email the client about the project delay')
  // LLM evaluates tone and content → may guide agent to soften language before sending
  // --8<-- [end:llm_steering]
}

// =====================
// Custom Context Provider
// =====================

async function customContextProviderExample() {
  // --8<-- [start:custom_context_provider]
  class ToolCallCounter implements SteeringContextProvider {
    readonly name = 'toolCallCounter'
    private _count = 0

    observeAgent(agent: LocalAgent): void {
      agent.addHook(AfterToolCallEvent, () => {
        this._count += 1
      })
    }

    get context(): SteeringContextData {
      return { type: 'toolCallCounter', totalCalls: this._count }
    }
  }

  const handler = new LLMSteeringHandler({
    systemPrompt: `
      Monitor tool usage. If the agent has made more than 5 tool calls,
      guide it to wrap up and produce a final answer.
    `,
    contextProviders: [new ToolCallCounter(), new ToolLedgerProvider()],
  })

  const agent = new Agent({
    tools: [searchWeb],
    interventions: [handler],
  })

  await agent.invoke('Research the history of quantum computing')
  // After 5+ tool calls, handler guides the agent to wrap up and produce a final answer
  // --8<-- [end:custom_context_provider]
}

// =====================
// Tool Ledger Config
// =====================

async function toolLedgerConfigExample() {
  // --8<-- [start:tool_ledger_config]
  const ledger = new ToolLedgerProvider({
    maxEntries: 50,
    name: 'my-app:tool-ledger',
  })

  const handler = new LLMSteeringHandler({
    systemPrompt: `
      You monitor tool call patterns. If a tool has failed 3 times consecutively,
      guide the agent to try a different approach rather than retrying.
    `,
    contextProviders: [ledger],
  })

  const agent = new Agent({
    tools: [searchWeb, sendEmail],
    interventions: [handler],
  })

  await agent.invoke('Find contact info for Acme Corp and send them a proposal')
  // If search_web fails 3 times, handler guides agent to try a different approach
  // --8<-- [end:tool_ledger_config]
}

void basicSteeringExample
void llmSteeringExample
void customContextProviderExample
void toolLedgerConfigExample
