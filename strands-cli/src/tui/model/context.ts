import type { Model } from '@strands-agents/sdk'

// Mirrors entries in strands-ts/src/models/defaults.ts that published @strands-agents/sdk releases lack.
// Remove once the CLI's minimum SDK version includes them. Values from the Bedrock model cards:
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7.html
const FALLBACK_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['openai.gpt-6-astra', 1_050_000],
  ['gpt-6-astra', 1_050_000],
  ['zai.glm-4.7', 203_000],
])

export function contextWindowLimit(model: Model): number | undefined {
  const configured = model.getConfig().contextWindowLimit
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return configured
  }

  const modelId = (model.modelId ?? '')
    .split('/')
    .at(-1)
    ?.replace(/^(?:global|apac|us-gov|us|eu|au|jp)\./, '')
  return modelId === undefined ? undefined : FALLBACK_CONTEXT_WINDOWS.get(modelId)
}
