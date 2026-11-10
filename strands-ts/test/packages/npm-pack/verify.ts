/**
 * Consumer fixture for .github/workflows/test-package-pack.yml. Runs against
 * the packed tarball with only non-optional peers installed, so any import
 * that transitively pulls an optional peer fails at module load.
 *
 * Subpaths deliberately NOT imported because they require optional peers:
 *   models/{anthropic,openai,google,vercel}, a2a, a2a/express,
 *   session/s3-storage, telemetry. Those are covered by the sibling
 *   `../esm-module` and `../cjs-module` suites.
 */

import {
  Agent,
  AgentResult,
  BedrockModel,
  ContextWindowOverflowError,
  FunctionTool,
  Model,
  StateStore,
  Tool,
  ZodTool,
  tool,
} from '@strands-agents/sdk'

import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

import {
  bash as barrelBash,
  fileEditor as barrelFileEditor,
  httpRequest as barrelHttpRequest,
  notebook as barrelNotebook,
} from '@strands-agents/sdk/vended-tools'

import {
  AgentSkills as BarrelAgentSkills,
  ContextOffloader as BarrelContextOffloader,
  GoalLoop as BarrelGoalLoop,
  InMemoryStorage as BarrelInMemoryStorage,
} from '@strands-agents/sdk/vended-plugins'

import { BedrockModel as BedrockFromSubpath } from '@strands-agents/sdk/models/bedrock'
import { Graph, Swarm, MultiAgentState } from '@strands-agents/sdk/multiagent'
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'
import { ContextOffloader, InMemoryStorage } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'

import { z } from 'zod'

console.log('[pack-test] Imports resolved')

const model = new BedrockModel({ region: 'us-west-2' })
if (!model.getConfig()) {
  throw new Error('BedrockModel config is invalid')
}
console.log('[pack-test] BedrockModel constructed')

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a specific location.',
  inputSchema: z.object({
    location: z.string().describe('The city and state, e.g., San Francisco, CA'),
  }),
  callback: (input) => `The weather in ${input.location} is 72F and sunny.`,
})

const response = await weatherTool.invoke({ location: 'New York' })
if (response !== 'The weather in New York is 72F and sunny.') {
  throw new Error(`Tool returned invalid response: ${String(response)}`)
}
console.log('[pack-test] Tool invocation produced expected output')

const agent = new Agent({ model, tools: [weatherTool] })
if (agent.tools.length === 0) {
  throw new Error('Tool was not correctly added to the agent')
}
console.log('[pack-test] Agent constructed with tool')

const vendedTools: Record<string, Tool> = { notebook, fileEditor, httpRequest, bash }
for (const [name, t] of Object.entries(vendedTools)) {
  if (!(t instanceof Tool)) {
    throw new Error(`Vended tool '${name}' is not a Tool instance`)
  }
}
console.log('[pack-test] All vended tools are Tool instances')

if (BedrockFromSubpath !== BedrockModel) {
  throw new Error('BedrockModel from subpath does not match main export')
}
if (!(model instanceof Model)) {
  throw new Error('BedrockModel is not a Model instance')
}
if (!(weatherTool instanceof FunctionTool) && !(weatherTool instanceof ZodTool)) {
  throw new Error('tool() factory returned an unexpected Tool subclass')
}
console.log('[pack-test] Subpath export identity + model/tool hierarchy verified')

const store = new StateStore({ count: 0 })
store.set('count', 1)
if (store.get('count') !== 1) {
  throw new Error('StateStore did not round-trip value')
}
console.log('[pack-test] StateStore round-trip verified')

const multiAgentState = new MultiAgentState()
if (!(multiAgentState instanceof MultiAgentState)) {
  throw new Error('MultiAgentState construction failed')
}
const skills = new AgentSkills({ skills: [] })
if (!(skills instanceof AgentSkills)) {
  throw new Error('AgentSkills construction failed')
}
const offloader = new ContextOffloader({ storage: new InMemoryStorage() })
if (!(offloader instanceof ContextOffloader)) {
  throw new Error('ContextOffloader construction failed')
}
const goalLoop = new GoalLoop({ goal: () => true, maxAttempts: 1 })
if (!(goalLoop instanceof GoalLoop)) {
  throw new Error('GoalLoop construction failed')
}
for (const [name, ctor] of Object.entries({ Graph, Swarm })) {
  if (typeof ctor !== 'function') {
    throw new Error(`${name} subpath export is not a constructor`)
  }
}
console.log('[pack-test] multiagent + vended-plugin subpaths constructible')

const ctxErr = new ContextWindowOverflowError('test')
if (!(ctxErr instanceof Error)) {
  throw new Error('ContextWindowOverflowError is not an Error subclass')
}

void AgentResult
console.log('[pack-test] Error + result types importable')

if (barrelBash !== bash || barrelFileEditor !== fileEditor || barrelHttpRequest !== httpRequest || barrelNotebook !== notebook) {
  throw new Error('Barrel vended-tools exports do not match individual subpath exports')
}
if (
  BarrelAgentSkills !== AgentSkills ||
  BarrelContextOffloader !== ContextOffloader ||
  BarrelGoalLoop !== GoalLoop ||
  BarrelInMemoryStorage !== InMemoryStorage
) {
  throw new Error('Barrel vended-plugins exports do not match individual subpath exports')
}
console.log('[pack-test] barrel exports match individual subpath exports')

console.log('[pack-test] OK')
