// @ts-nocheck
import { tool } from '@langchain/core/tools'
import {
  END,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
  type GraphNode,
} from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt'
import { z } from 'zod'

// --8<-- [start:graph_before]
const fetchCaseRecord = tool(async ({ caseId }) => '...', {
  name: 'fetch_case_record',
  description: 'Fetch the filed record for a case.',
  schema: z.object({ caseId: z.string() }),
})

const searchPrecedent = tool(async ({ question }) => '...', {
  name: 'search_precedent',
  description: 'Search prior decisions for relevant precedent.',
  schema: z.object({ question: z.string() }),
})

const CaseState = new StateSchema({
  messages: MessagesValue,
  prompt: z.string(),
  researchText: z.string(),
  analysisText: z.string(),
  reviewText: z.string(),
})

const research: GraphNode<typeof CaseState> = async (state) => ({/* ... */})
const analysis: GraphNode<typeof CaseState> = async (state) => ({/* ... */})
const review: GraphNode<typeof CaseState> = async (state) => ({/* ... */})

const builder = new StateGraph(CaseState)
  .addNode('research', research)
  .addNode('research_tools', new ToolNode([fetchCaseRecord]))
  .addNode('analysis', analysis)
  .addNode('analysis_tools', new ToolNode([searchPrecedent]))
  .addNode('review', review)
  .addEdge(START, 'research')
  .addConditionalEdges('research', toolsCondition, {
    tools: 'research_tools',
    [END]: 'analysis',
  })
  .addEdge('research_tools', 'research')
  .addConditionalEdges('analysis', toolsCondition, {
    tools: 'analysis_tools',
    [END]: 'review',
  })
  .addEdge('analysis_tools', 'analysis')
  .addEdge('review', END)

const graph = builder.compile({ checkpointer: SqliteSaver.fromConnString('cases.db') })

// Entrypoint: this signature is what your callers use, and it stays the same
export async function runCase(caseId: string, prompt: string) {
  // External ID: caseId keys the conversation, and becomes the Strands session id
  const config = { configurable: { thread_id: caseId } }
  return graph.invoke({ prompt }, config)
}
// --8<-- [end:graph_before]
