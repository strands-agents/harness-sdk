import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

// --8<-- [start:direct_passing]
// Create specialized agents
const researchAgent = new Agent({
  name: 'research_agent',
  description:
    'Provides factual, well-sourced information in response to research questions.',
  systemPrompt: `You are a specialized research assistant. Focus only on providing
factual, well-sourced information in response to research questions.
Always cite your sources when possible.`,
  printer: false,
})

const productAgent = new Agent({
  name: 'product_agent',
  description: 'Provides personalized product suggestions based on user preferences.',
  systemPrompt: `You are a specialized product recommendation assistant.
Provide personalized product suggestions based on user preferences.`,
  printer: false,
})

const travelAgent = new Agent({
  name: 'travel_agent',
  description: 'Creates detailed travel itineraries based on user preferences.',
  systemPrompt: `You are a specialized travel planning assistant.
Create detailed travel itineraries based on user preferences.`,
  printer: false,
})

// Create the orchestrator: agents are automatically converted to tools
const orchestrator = new Agent({
  systemPrompt: `You are an assistant that routes queries to specialized agents:
- For research questions and factual information → Use the research_agent tool
- For product recommendations and shopping advice → Use the product_agent tool
- For travel planning and itineraries → Use the travel_agent tool
- For simple questions not requiring specialized knowledge → Answer directly

Always select the most appropriate tool based on the user's query.`,
  tools: [researchAgent, productAgent, travelAgent],
})
// --8<-- [end:direct_passing]

void orchestrator

{
  // --8<-- [start:as_tool_customization]
  const orchestrator = new Agent({
    systemPrompt: 'You are an assistant that routes queries to specialized agents.',
    tools: [
      researchAgent.asTool({
        name: 'research_assistant',
        description:
          'Process and respond to research-related queries requiring factual information.',
      }),
    ],
  })
  // --8<-- [end:as_tool_customization]
}

{
  // --8<-- [start:as_tool_context]
  // Agent will remember prior interactions within the same orchestrator session
  const orchestrator = new Agent({
    systemPrompt: 'You are an assistant that routes queries to specialized agents.',
    tools: [researchAgent.asTool({ preserveContext: true })],
  })
  // --8<-- [end:as_tool_context]
}

// --8<-- [start:research_assistant]
const researchAssistant = tool({
  name: 'research_assistant',
  description:
    'Process and respond to research-related queries requiring factual information.',
  inputSchema: z.object({
    query: z.string().describe('A research question requiring factual information'),
  }),
  callback: async (input) => {
    const researchAgent = new Agent({
      systemPrompt: `You are a specialized research assistant. Focus only on providing
factual, well-sourced information in response to research questions.
Always cite your sources when possible.`,
    })

    const response = await researchAgent.invoke(input.query)
    return response.lastMessage.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
  },
})
// --8<-- [end:research_assistant]

// --8<-- [start:multiple_specialists]
const productRecommendationAssistant = tool({
  name: 'product_recommendation_assistant',
  description:
    'Handle product recommendation queries by suggesting appropriate products.',
  inputSchema: z.object({
    query: z.string().describe('A product inquiry with user preferences'),
  }),
  callback: async (input) => {
    const productAgent = new Agent({
      systemPrompt: `You are a specialized product recommendation assistant.
Provide personalized product suggestions based on user preferences.`,
    })

    const response = await productAgent.invoke(input.query)
    return response.lastMessage.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
  },
})

const tripPlanningAssistant = tool({
  name: 'trip_planning_assistant',
  description: 'Create travel itineraries and provide travel advice.',
  inputSchema: z.object({
    query: z
      .string()
      .describe('A travel planning request with destination and preferences'),
  }),
  callback: async (input) => {
    const travelAgent = new Agent({
      systemPrompt: `You are a specialized travel planning assistant.
Create detailed travel itineraries based on user preferences.`,
    })

    const response = await travelAgent.invoke(input.query)
    return response.lastMessage.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
  },
})
// --8<-- [end:multiple_specialists]

async function orchestratorExample() {
  // --8<-- [start:orchestrator]
  const orchestrator = new Agent({
    systemPrompt: `You are an assistant that routes queries to specialized agents:
- For research questions and factual information → Use the research_assistant tool
- For recommendations and advice → Use the product_recommendation_assistant tool
- For travel planning and itineraries → Use the trip_planning_assistant tool
- For simple questions not requiring specialized knowledge → Answer directly

Always select the most appropriate tool based on the user's query.`,
    tools: [researchAssistant, productRecommendationAssistant, tripPlanningAssistant],
  })
  // --8<-- [end:orchestrator]

  // --8<-- [start:usage]
  const response = await orchestrator.invoke(
    "I'm looking for hiking boots for a trip to Patagonia next month"
  )
  // --8<-- [end:usage]
  void response
}

void orchestratorExample

async function delegationBasicExample() {
  // --8<-- [start:delegation_basic]
  const BillingResponseSchema = z.object({
    summary: z.string(),
    refundAmount: z.number(),
  })

  const billingAgent = new Agent({
    name: 'billing_expert',
    description: 'Answers billing questions: charges, refunds, and invoices.',
    systemPrompt: 'You handle billing questions with precision.',
    structuredOutputSchema: BillingResponseSchema,
    printer: false,
  })

  const orchestrator = new Agent({
    systemPrompt: `Route billing questions to billing_expert.
Answer general questions yourself.`,
    tools: [billingAgent.asTool({ delegate: true })],
  })

  const result = await orchestrator.invoke('Why was I charged twice?')
  // result contains the billing agent's structured JSON response, unchanged
  // --8<-- [end:delegation_basic]
  void result
}
void delegationBasicExample
