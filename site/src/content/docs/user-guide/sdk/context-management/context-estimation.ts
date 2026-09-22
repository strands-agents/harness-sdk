import { BedrockModel } from '@strands-agents/sdk'

async function contextWindowLimit() {
  // --8<-- [start:context_window_limit]
  const model = new BedrockModel({
    modelId: 'my-custom-model',
    contextWindowLimit: 128_000,
  })
  // --8<-- [end:context_window_limit]

  const projectedTokens = 50_000
  // --8<-- [start:utilization]
  const ratio = model.estimateUtilization(projectedTokens)
  // ratio is 0-1+ (above 1.0 means overflow)
  // --8<-- [end:utilization]
}
