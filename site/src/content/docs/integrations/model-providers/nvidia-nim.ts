import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

async function usage() {
  // --8<-- [start:usage]
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: process.env.NVIDIA_API_KEY,
    clientConfig: {
      baseURL: 'https://integrate.api.nvidia.com/v1',
    },
    modelId: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Explain tool calling in one sentence.')
  console.log(response)
  // --8<-- [end:usage]
}
