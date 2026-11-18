import { BedrockModel, LLMDecisionModel } from '@strands-agents/sdk'

function configurationExample() {
  // --8<-- [start:configuration]
  const decisions = new LLMDecisionModel({
    model: new BedrockModel({
      modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      // Constrain the model's tool input to the answer schema
      strictTools: true,
    }),
    systemPrompt: "You triage messages sent to an online store's support team.",
  })
  // --8<-- [end:configuration]
}
