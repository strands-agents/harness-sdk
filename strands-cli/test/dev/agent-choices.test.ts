import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agentChoicesProblem, saveAgentChoices } from '../../src/dev/agent-choices.js'
import { AgentOptionConflict, AgentOptionsNotEditable } from '../../src/dev/agent-options.js'
import { pythonExecutable } from '../fixtures/python-runtime.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'

const agent = async (language: 'typescript' | 'python', source: string) => {
  const root = await temporaryDirectory()
  const entrypoint = join(root, language === 'python' ? 'agent.py' : 'agent.ts')
  await writeFile(entrypoint, source)
  return { root, entrypoint, config: { language } }
}

const typescriptAgent = (model: string, prelude = '') => `import { createHarness } from '@strands-agents/harness'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
${prelude}
export const agent = await createHarness({
  name: 'Demo',
  ${model},
})
`

afterEach(() => vi.unstubAllEnvs())

describe('saving effort into a TypeScript agent', () => {
  it('shouldWriteTheEffortOptionWhenTheModelIsAnIdString', async () => {
    const workspace = await agent('typescript', typescriptAgent(`model: 'bedrock/${SONNET}'`))

    expect(await saveAgentChoices(workspace, { effort: 'low' })).toBe(true)

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
      typescriptAgent(`model: 'bedrock/${SONNET}',\n  effort: 'low'`)
    )
  })

  it('shouldAddTheReasoningFieldsToTheModelObjectWhenTheModelIsBuiltInline', async () => {
    const workspace = await agent(
      'typescript',
      typescriptAgent(`model: new BedrockModel({ modelId: '${SONNET}', region: 'us-west-2' })`)
    )

    await saveAgentChoices(workspace, { effort: 'low' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
      typescriptAgent(
        `model: new BedrockModel({ modelId: '${SONNET}', region: 'us-west-2', additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 } } })`
      )
    )
  })

  it('shouldReplaceOnlyTheReasoningFieldsWhenTheModelObjectIsAVariable', async () => {
    const prelude = `
const model = new BedrockModel({
  modelId: '${SONNET}',
  additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 }, anthropic_beta: ['beta'] },
})
`
    const workspace = await agent('typescript', typescriptAgent('model', prelude))

    await saveAgentChoices(workspace, { effort: 'medium' }, { effort: 'low' })

    const source = await readFile(workspace.entrypoint, 'utf8')
    expect(source).toContain(`modelId: '${SONNET}',\n  additionalRequestFields: {\n    anthropic_beta: ['beta'],`)
    expect(source).toContain('budget_tokens: 8192')
    expect(source).not.toContain('effort:')
  })

  it('shouldRemoveTheReasoningFieldsWhenTheEffortIsOff', async () => {
    const prelude = `
const model = new BedrockModel({
  modelId: '${SONNET}',
  additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: 2048 } },
  region: 'us-west-2',
})
`
    const workspace = await agent('typescript', typescriptAgent('model', prelude))

    await saveAgentChoices(workspace, { effort: 'off' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
      typescriptAgent(
        'model',
        `
const model = new BedrockModel({
  modelId: '${SONNET}',
  region: 'us-west-2',
})
`
      )
    )
  })

  it('shouldRefuseWhenTheModelRunsAtAnotherEffortThanExpected', async () => {
    const workspace = await agent('typescript', typescriptAgent(`model: new BedrockModel({ modelId: '${SONNET}' })`))

    await expect(saveAgentChoices(workspace, { effort: 'high' }, { effort: 'low' })).rejects.toThrow(
      new AgentOptionConflict('agent.ts now runs its model at effort "off", not "low". Review the change again.')
    )
  })

  it.each([
    [
      'a model from a loaded module',
      `model: extensions['model']`,
      'agent.ts builds its model in code that strands dev cannot read. Set effort on that model yourself.',
    ],
    [
      'an unsupported model class',
      `model: new OllamaModel({ modelId: 'llama3' })`,
      'agent.ts: strands dev can set effort only on BedrockModel, AnthropicModel, OpenAIModel objects, not on OllamaModel. Set effort on that model yourself.',
    ],
    [
      'reasoning fields set in code',
      `model: new BedrockModel({ modelId: '${SONNET}', additionalRequestFields: fields })`,
      'agent.ts sets the BedrockModel additionalRequestFields in code. Set effort on that model yourself.',
    ],
  ])('shouldExplainWhyTheEffortCannotBeSavedWhenTheAgentUses %s', async (_case, model, message) => {
    const source = typescriptAgent(model)
    const workspace = await agent('typescript', source)

    await expect(saveAgentChoices(workspace, { effort: 'low' })).rejects.toThrow(new AgentOptionsNotEditable(message))
    expect(await agentChoicesProblem(workspace, { effort: 'low' })).toBe(message)
    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source)
  })

  it('shouldReportNoProblemWhenTheEffortCanBeSaved', async () => {
    const workspace = await agent('typescript', typescriptAgent(`model: new BedrockModel({ modelId: '${SONNET}' })`))

    expect(await agentChoicesProblem(workspace, { effort: 'low' }, { effort: 'off' })).toBeUndefined()
  })
})

const pythonAgent = (model: string, prelude = '') => `from strands.models import BedrockModel
from strands_harness import create_harness
${prelude}
agent = create_harness(
    name="Demo",
    ${model},
)
`

describe('saving effort into a Python agent without a usable interpreter', () => {
  it('shouldReportThatTheEffortCannotBeSavedWhenThePythonPathCannotStartAProcess', async () => {
    const file = join(await temporaryDirectory(), 'notes.txt')
    await writeFile(file, '')
    vi.stubEnv('PYTHON', join(file, 'python'))
    const workspace = await agent('python', pythonAgent(`model=BedrockModel(model_id="${SONNET}")`))

    await expect(saveAgentChoices(workspace, { effort: 'low' })).rejects.toThrow(AgentOptionsNotEditable)
  })
})

describe.skipIf(!existsSync(pythonExecutable))('saving effort into a Python agent', () => {
  beforeEach(() => {
    vi.stubEnv('PYTHON', pythonExecutable)
  })

  it('shouldAddTheReasoningFieldsToTheModelObjectWhenTheModelIsBuiltInline', async () => {
    const workspace = await agent('python', pythonAgent(`model=BedrockModel(model_id="${SONNET}")`))

    await saveAgentChoices(workspace, { effort: 'low' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
      pythonAgent(
        `model=BedrockModel(model_id="${SONNET}", additional_request_fields={"thinking": {"type": "enabled", "budget_tokens": 2048}})`
      )
    )
  })

  it('shouldReplaceTheReasoningFieldsWhenTheModelObjectIsAModuleVariable', async () => {
    const prelude = `
model = BedrockModel(
    model_id="${SONNET}",
    additional_request_fields={"thinking": {"type": "enabled", "budget_tokens": 2048}},
    max_tokens=4096,
)
`
    const workspace = await agent('python', pythonAgent('model=model', prelude))

    await saveAgentChoices(workspace, { effort: 'high' }, { effort: 'low' })

    const source = await readFile(workspace.entrypoint, 'utf8')
    expect(source).toContain('"budget_tokens": 4095')
    expect(source).toContain('max_tokens=4096,')
  })

  it('shouldRemoveTheReasoningFieldsWhenTheEffortIsOff', async () => {
    const prelude = `
model = BedrockModel(
    model_id="${SONNET}",
    additional_request_fields={"thinking": {"type": "enabled", "budget_tokens": 2048}},
)
`
    const workspace = await agent('python', pythonAgent('model=model', prelude))

    await saveAgentChoices(workspace, { effort: 'off' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
      pythonAgent('model=model', `\nmodel = BedrockModel(\n    model_id="${SONNET}",\n)\n`)
    )
  })

  it('shouldRefuseTheChatCompletionsModelWhenThePythonAgentBuildsAnOpenAIModel', async () => {
    const source = pythonAgent('model=OpenAIModel(model_id="gpt-5")')
    const workspace = await agent('python', source)

    await expect(saveAgentChoices(workspace, { effort: 'low' })).rejects.toThrow(
      new AgentOptionsNotEditable(
        'agent.py: strands dev can set effort only on BedrockModel, AnthropicModel, OpenAIResponsesModel objects, not on OpenAIModel. Set effort on that model yourself.'
      )
    )
    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(source)
  })

  it('shouldWriteTheEffortOptionWhenTheModelIsAnIdString', async () => {
    const workspace = await agent('python', pythonAgent(`model="bedrock/${SONNET}"`))

    await saveAgentChoices(workspace, { effort: 'low' })

    expect(await readFile(workspace.entrypoint, 'utf8')).toBe(
      pythonAgent(`model="bedrock/${SONNET}",\n    effort="low"`)
    )
  })
})
