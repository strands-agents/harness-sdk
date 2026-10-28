import type { Model } from '@strands-agents/sdk'

// Mirrors entries in strands-ts/src/models/defaults.ts (the source of these values) that the CLI's minimum
// published @strands-agents/sdk release lacks. Remove once the minimum SDK version includes them.
const FALLBACK_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['claude-opus-5-5', 1_000_000],
  ['claude-fable-5-1', 1_000_000],
  ['claude-sonnet-5-5', 1_000_000],
  ['claude-haiku-5-5', 1_000_000],
  ['anthropic.claude-opus-5-5', 1_000_000],
  ['anthropic.claude-fable-5-1', 1_000_000],
  ['anthropic.claude-sonnet-5-5', 1_000_000],
  ['anthropic.claude-haiku-5-5', 1_000_000],
  ['zai.glm-4.7', 203_000],
  ['zai.glm-4.7-flash', 203_000],
  ['zai.glm-5', 200_000],
  ['zai.glm-5.3', 1_000_000],
  ['openai.gpt-oss-120b', 128_000],
  ['openai.gpt-oss-120b-1:0', 128_000],
  ['openai.gpt-oss-20b', 128_000],
  ['openai.gpt-oss-20b-1:0', 128_000],
  ['openai.gpt-oss-safeguard-120b', 128_000],
  ['openai.gpt-oss-safeguard-20b', 128_000],
  ['openai.gpt-6-astra', 1_050_000],
  ['openai.gpt-6.1-sol', 1_000_000],
  ['openai.gpt-6-sol', 1_050_000],
  ['openai.gpt-6-luna', 1_050_000],
  ['openai.gpt-5.6-sol', 1_050_000],
  ['openai.gpt-5.6-terra', 1_050_000],
  ['openai.gpt-5.6-luna', 1_050_000],
  ['openai.gpt-5.5', 1_050_000],
  ['openai.gpt-5.4', 1_050_000],
  ['mistral.mistral-large-3-675b-instruct', 256_000],
  ['mistral.ministral-3-14b-instruct', 128_000],
  ['mistral.ministral-3-8b-instruct', 128_000],
  ['mistral.ministral-3-3b-instruct', 128_000],
  ['mistral.magistral-small-2509', 128_000],
  ['mistral.pixtral-large-2502-v1:0', 128_000],
  ['mistral.mistral-small-2402-v1:0', 32_000],
  ['mistral.mistral-large-2402-v1:0', 32_000],
  ['google.gemma-4-31b', 256_000],
  ['google.gemma-4-26b-a4b', 256_000],
  ['google.gemma-4-e2b', 128_000],
  ['xai.grok-4.7', 524_288],
  ['xai.grok-4.6', 500_000],
  ['xai.grok-4.3', 1_000_000],
  ['chat-latest', 272_000],
  ['gpt-6.1-sol', 1_050_000],
  ['gpt-6-sol', 1_050_000],
  ['gpt-6-luna', 1_050_000],
  ['gpt-oss-120b', 131_072],
  ['gpt-oss-20b', 131_072],
  ['gemini-4-argon', 1_048_576],
  ['gemini-3.8-flash', 1_048_576],
  ['gemini-3.7-flash', 1_048_576],
])

export function contextWindowLimit(model: Model): number | undefined {
  const configured = model.getConfig().contextWindowLimit
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return configured
  }

  // Keep in step with BEDROCK_REGION_PREFIXES in strands-ts/src/models/defaults.ts, plus 'in' (#4893).
  const modelId = (model.modelId ?? '')
    .split('/')
    .at(-1)
    ?.replace(/^(?:global|apac|us-gov|us|eu|ap|in|au|jp)\./, '')
  return modelId === undefined ? undefined : FALLBACK_CONTEXT_WINDOWS.get(modelId)
}
