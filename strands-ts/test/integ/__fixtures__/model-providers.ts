/**
 * Contains helpers for creating various model providers that work both in node & the browser
 */

import { inject } from 'vitest'
import { BedrockModel, type BedrockModelOptions } from '$/sdk/models/bedrock.js'
import { OpenAIModel, type OpenAIModelOptions } from '$/sdk/models/openai/index.js'
import { AnthropicModel, type AnthropicModelOptions } from '$/sdk/models/anthropic.js'
import { GoogleModel, type GoogleModelOptions } from '$/sdk/models/google/model.js'
import { VercelModel, type VercelModelConfig } from '$/sdk/models/vercel.js'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createOpenAI } from '@ai-sdk/openai'

/**
 * Feature support flags for model providers.
 * Used to conditionally run tests based on model capabilities.
 *
 * TODO: after https://github.com/strands-agents/harness-sdk/issues/780 this config should be in src not test
 */
export interface ProviderFeatures {
  reasoning: boolean
  tools: boolean
  toolThinking: boolean
  builtInTools: boolean
  images: boolean
  documents: boolean
  video: boolean
  citations: boolean
}

export const bedrock = {
  name: 'BedrockModel',
  supports: {
    reasoning: true,
    tools: true,
    toolThinking: false,
    builtInTools: false,
    images: true,
    documents: true,
    video: true,
    citations: true,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: {
      modelId: 'global.anthropic.claude-sonnet-4-6',
      additionalRequestFields: { thinking: { type: 'enabled', budget_tokens: 1024 } },
    },
    video: { modelId: 'us.amazon.nova-pro-v1:0' },
  },
  get skip() {
    return inject('provider-bedrock').shouldSkip
  },
  createModel: (options: BedrockModelOptions = {}): BedrockModel => {
    const credentials = inject('provider-bedrock')?.credentials
    if (!credentials) {
      throw new Error('No Bedrock credentials provided')
    }
    return new BedrockModel({
      ...options,
      clientConfig: { ...(options.clientConfig ?? {}), credentials },
    })
  },
}

export const openai = {
  name: 'OpenAIModel',
  supports: {
    reasoning: false,
    tools: true,
    toolThinking: false,
    builtInTools: false,
    images: true,
    documents: true,
    video: false,
    citations: false,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: { modelId: 'o4-mini' },
    video: {},
  },
  get skip() {
    return inject('provider-openai').shouldSkip
  },
  createModel: (config: Omit<OpenAIModelOptions, 'api'> = {}): OpenAIModel => {
    const apiKey = inject('provider-openai')?.apiKey
    if (!apiKey) {
      throw new Error('No OpenAI apiKey provided')
    }
    return new OpenAIModel({
      ...config,
      api: 'chat',
      apiKey,
      clientConfig: { ...(config.clientConfig ?? {}), dangerouslyAllowBrowser: true },
    })
  },
}

export const openaiResponses = {
  name: "OpenAIModel (api: 'responses')",
  supports: {
    reasoning: true,
    tools: true,
    toolThinking: false,
    builtInTools: true,
    images: true,
    documents: true,
    video: false,
    citations: true,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: { modelId: 'o4-mini' },
    video: {},
  },
  get skip() {
    return inject('provider-openai').shouldSkip
  },
  createModel: (
    config: Omit<Extract<OpenAIModelOptions, { api?: 'responses' }>, 'api' | 'client'> = {}
  ): OpenAIModel => {
    const apiKey = inject('provider-openai')?.apiKey
    if (!apiKey) {
      throw new Error('No OpenAI apiKey provided')
    }
    return new OpenAIModel({
      ...config,
      api: 'responses',
      apiKey,
      clientConfig: { ...(config.clientConfig ?? {}), dangerouslyAllowBrowser: true },
    })
  },
}

export const anthropic = {
  name: 'AnthropicModel',
  supports: {
    reasoning: true,
    tools: true,
    toolThinking: false,
    builtInTools: false,
    images: true,
    documents: true,
    video: false,
    citations: false,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: {
      modelId: 'claude-sonnet-4-6',
      params: { thinking: { type: 'enabled', budget_tokens: 1024 } },
    },
    video: {},
  },
  get skip() {
    return inject('provider-anthropic').shouldSkip
  },
  createModel: (config: AnthropicModelOptions = {}): AnthropicModel => {
    const apiKey = inject('provider-anthropic')?.apiKey
    if (!apiKey) {
      throw new Error('No Anthropic apiKey provided')
    }

    return new AnthropicModel({
      ...config,
      apiKey: apiKey,
      clientConfig: {
        ...(config.clientConfig ?? {}),
        dangerouslyAllowBrowser: true,
      },
    })
  },
}

export const gemini = {
  name: 'GoogleModel',
  supports: {
    reasoning: true,
    tools: true,
    toolThinking: true,
    builtInTools: true,
    images: true,
    documents: true,
    video: true,
    citations: false,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: {
      modelId: 'gemini-2.5-flash',
      params: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
    },
    builtInTools: {
      builtInTools: [{ codeExecution: {} }],
    },
    video: {},
  },
  get skip() {
    return inject('provider-gemini').shouldSkip
  },
  createModel: (config: GoogleModelOptions = {}): GoogleModel => {
    const apiKey = inject('provider-gemini').apiKey
    if (!apiKey) {
      throw new Error('No Gemini apiKey provided')
    }
    return new GoogleModel({ ...config, apiKey })
  },
}

/**
 * OpenAI-compatible Bedrock Mantle endpoint. Authenticates with the ambient AWS credential
 * chain (same gate as Bedrock), so it is node-only and not part of `allProviders`.
 */
export const mantle = {
  name: 'OpenAIModel (Bedrock Mantle)',
  get skip() {
    return inject('provider-bedrock').shouldSkip
  },
  createModel: (config: Omit<OpenAIModelOptions, 'apiKey' | 'client' | 'bedrockMantleConfig'> = {}): OpenAIModel => {
    return new OpenAIModel({ ...config, bedrockMantleConfig: { region: 'us-east-1' } })
  },
}

export const vercelBedrock = {
  name: 'VercelModel (Bedrock)',
  supports: {
    reasoning: true,
    tools: true,
    toolThinking: false,
    builtInTools: false,
    images: true,
    documents: true,
    video: false,
    citations: false,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: {
      providerOptions: {
        bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 1024 } },
      },
    },
    video: {},
  },
  get skip() {
    return inject('provider-bedrock').shouldSkip
  },
  createModel: (config: Partial<VercelModelConfig> = {}): VercelModel => {
    const credentials = inject('provider-bedrock')?.credentials
    if (!credentials) {
      throw new Error('No Bedrock credentials provided')
    }
    const provider = createAmazonBedrock({
      ...(!credentials.expiration && { region: 'us-west-2' }),
      credentialProvider: () => Promise.resolve(credentials),
    })
    const { providerOptions, ...rest } = config as Partial<VercelModelConfig> & {
      providerOptions?: Record<string, unknown>
    }
    return new VercelModel({
      provider: provider('global.anthropic.claude-sonnet-4-6'),
      ...rest,
      ...(providerOptions && { providerOptions }),
    })
  },
}

export const vercelOpenAI = {
  name: 'VercelModel (OpenAI)',
  supports: {
    reasoning: false,
    tools: true,
    toolThinking: false,
    builtInTools: false,
    images: true,
    documents: true,
    video: false,
    citations: false,
  } satisfies ProviderFeatures,
  models: {
    default: {},
    reasoning: { modelId: 'o1-mini' },
    video: {},
  },
  get skip() {
    return inject('provider-openai').shouldSkip
  },
  createModel: (config: Partial<VercelModelConfig> = {}): VercelModel => {
    const apiKey = inject('provider-openai')?.apiKey
    if (!apiKey) {
      throw new Error('No OpenAI apiKey provided')
    }
    const provider = createOpenAI({ apiKey })
    const { providerOptions, ...rest } = config as Partial<VercelModelConfig> & {
      providerOptions?: Record<string, unknown>
    }
    return new VercelModel({
      provider: provider('gpt-4o'),
      ...rest,
      ...(providerOptions && { providerOptions }),
    })
  },
}

export const allProviders = [bedrock, openai, anthropic, gemini, vercelBedrock, vercelOpenAI]
