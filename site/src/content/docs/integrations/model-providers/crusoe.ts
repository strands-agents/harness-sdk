import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

async function usage() {
  // --8<-- [start:usage]
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: process.env.CRUSOE_API_KEY,
    clientConfig: {
      baseURL: 'https://api.inference.crusoecloud.com/v1/',
    },
    modelId: 'zai/GLM-5.2',
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Explain tool calling in one sentence.')
  console.log(response)
  // --8<-- [end:usage]
}
