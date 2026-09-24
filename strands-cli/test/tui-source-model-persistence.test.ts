import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import { BedrockModel } from '@strands-agents/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ChatConversation } from '../src/tui/chat/types.js'
import { CliConfigStore } from '../src/tui/config.js'
import * as discovery from '../src/tui/provider/discovery.js'
import { createInteractiveChat } from '../src/tui/runtime.js'
import type { ConversationManager } from '../src/tui/session/conversations.js'

const authoredModel = 'bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0'
const selectedModel = 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0'
let root: string
const chats: ConversationManager[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strands-source-selection-'))
  vi.spyOn(discovery, 'discoverProviderModels').mockResolvedValue({
    available: true,
    complete: true,
    models: [{ id: selectedModel.slice('bedrock/'.length), name: 'Haiku' }],
  })
})

afterEach(async () => {
  await Promise.all(chats.splice(0).map((chat) => chat.dispose()))
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function open(
  overrides: HarnessAgentOptions = {},
  conversation?: ChatConversation,
  source = join(root, 'agent.ts')
): Promise<ConversationManager> {
  const chat = await createInteractiveChat({
    project: { root, entrypoint: source, language: 'typescript' },
    agentOptions: {
      model: authoredModel,
      effort: 'off',
      builtinTools: [],
      builtinPlugins: [],
      session: false,
      memory: false,
      caching: false,
      skills: false,
      contextManager: false,
      backgroundTasks: false,
      ...overrides,
    },
    config: CliConfigStore.memory({}, { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false }),
    cwd: root,
    sessionCatalogPath: join(root, 'catalog.json'),
    persistModelChanges: false,
    ...(conversation ? { conversation } : {}),
  })
  chats.push(chat)
  return chat
}

it('keeps a UI-selected model and effort only for the same unchanged source definition', async () => {
  const initial = await open()
  await initial.submit(`/model ${selectedModel}`)
  await initial.submit('/effort high')
  expect(initial.backend.info?.()).toMatchObject({
    model: selectedModel.slice('bedrock/'.length),
    effort: 'High',
  })

  const conversation = await initial.captureConversation()
  const prompt = await open({ systemPrompt: 'Updated instructions' }, conversation)
  const thinking = await open({ effort: 'low' }, conversation)
  const model = await open({ model: 'bedrock/anthropic.claude-opus-4-8' }, conversation)
  const otherSource = await open({}, conversation, join(root, 'other', 'agent.ts'))
  const custom = await open(
    { model: new BedrockModel({ modelId: authoredModel.slice('bedrock/'.length) }) },
    conversation
  )

  expect({
    prompt: prompt.backend.info?.(),
    thinking: thinking.backend.info?.(),
    model: model.backend.info?.(),
    otherSource: otherSource.backend.info?.(),
    custom: custom.backend.info?.(),
  }).toMatchObject({
    prompt: { model: selectedModel.slice('bedrock/'.length), effort: 'High' },
    thinking: { model: authoredModel.slice('bedrock/'.length), effort: 'Low' },
    model: { model: 'anthropic.claude-opus-4-8', effort: 'Off' },
    otherSource: { model: authoredModel.slice('bedrock/'.length), effort: 'Off' },
    custom: { model: authoredModel.slice('bedrock/'.length), effort: 'Off' },
  })
})
