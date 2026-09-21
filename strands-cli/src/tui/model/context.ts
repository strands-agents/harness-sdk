import type { Model } from '@strands-agents/sdk'

export function contextWindowLimit(model: Model): number | undefined {
  const configured = model.getConfig().contextWindowLimit
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return configured
  }

  const modelId = (model.modelId ?? '')
    .split('/')
    .at(-1)
    ?.replace(/^(?:global|apac|us-gov|us|eu|au|jp)\./, '')
  // Bedrock's catalog omits this value: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html
  return modelId === 'openai.gpt-6-astra' || modelId === 'gpt-6-astra' ? 1_050_000 : undefined
}
