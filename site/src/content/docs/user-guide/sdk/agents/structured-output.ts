import { Agent, StructuredOutputError, tool } from '@strands-agents/sdk'
import { z } from 'zod'

async function triageExample() {
  // --8<-- [start:triage]
  const TicketTriageSchema = z
    .object({
      category: z
        .enum(['billing', 'bug', 'account', 'other'])
        .describe('The team that should handle the message'),
      priority: z
        .enum(['low', 'medium', 'high'])
        .describe('high when the customer is blocked or losing money'),
      summary: z.string().describe('One sentence describing the problem'),
    })
    .describe('Routing decision for one customer support message')

  type TicketTriage = z.infer<typeof TicketTriageSchema>

  async function triage(message: string): Promise<TicketTriage> {
    // A fresh agent per message keeps tickets from sharing conversation history
    const agent = new Agent({ printer: false })
    try {
      const result = await agent.invoke(message, {
        structuredOutputSchema: TicketTriageSchema,
      })
      return result.structuredOutput as TicketTriage
    } catch (error) {
      if (error instanceof StructuredOutputError) {
        // Send anything the agent can't classify to a person
        return { category: 'other', priority: 'medium', summary: message }
      }
      throw error
    }
  }

  const ticket = await triage(
    'I was charged twice this month and need one of the charges refunded.'
  )
  console.log(`${ticket.priority} | ${ticket.category} | ${ticket.summary}`)
  // --8<-- [end:triage]
}

async function withToolsExample() {
  // --8<-- [start:with_tools]
  const customers: Record<string, { name: string; plan: string }> = {
    'dana@example.com': { name: 'Dana Ruiz', plan: 'enterprise' },
  }

  const lookupCustomer = tool({
    name: 'lookup_customer',
    description: "Look up a customer's name and plan by email address.",
    inputSchema: z.object({ email: z.string() }),
    callback: ({ email }) => customers[email] ?? { name: 'unknown', plan: 'free' },
  })

  const CustomerTicketSchema = z.object({
    customerName: z.string(),
    plan: z.enum(['free', 'pro', 'enterprise']),
    priority: z.enum(['low', 'medium', 'high']),
  })

  const agent = new Agent({ tools: [lookupCustomer], printer: false })
  const result = await agent.invoke(
    'From dana@example.com: our dashboard has been down for an hour.',
    { structuredOutputSchema: CustomerTicketSchema }
  )
  console.log(result.structuredOutput)
  // --8<-- [end:with_tools]
}

async function fromHistoryExample() {
  // --8<-- [start:from_history]
  const EscalationSchema = z.object({
    problem: z.string(),
    stepsTried: z.array(z.string()),
  })

  const agent = new Agent({ printer: false })
  await agent.invoke("Hi, I can't log in to my account.")
  await agent.invoke('I reset my password twice, and the reset email never arrives.')

  const result = await agent.invoke(
    'Summarize this conversation for the escalation team.',
    { structuredOutputSchema: EscalationSchema }
  )
  const escalation = result.structuredOutput as z.infer<typeof EscalationSchema>
  console.log(escalation.problem)
  for (const step of escalation.stepsTried) {
    console.log(`- ${step}`)
  }
  // --8<-- [end:from_history]
}

async function streamingExample() {
  // --8<-- [start:streaming]
  const ReplyDraftSchema = z.object({
    subject: z.string(),
    body: z.string(),
  })

  type ReplyDraft = z.infer<typeof ReplyDraftSchema>

  const agent = new Agent({ printer: false })
  const stream = agent.stream('Draft a reply apologizing for a delayed refund.', {
    structuredOutputSchema: ReplyDraftSchema,
  })

  for await (const event of stream) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta.type === 'textDelta'
    ) {
      process.stdout.write(event.event.delta.text)
    } else if (event.type === 'agentResultEvent') {
      const draft = event.result.structuredOutput as ReplyDraft
      console.log(`\nSubject: ${draft.subject}`)
    }
  }
  // --8<-- [end:streaming]
}
