import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

async function usage() {
  // --8<-- [start:usage]
  const model = new OpenAIModel({
    api: 'chat',
    // A non-empty API key is required; the keyless free tier is not supported
    apiKey: process.env.OVHCLOUD_API_KEY,
    clientConfig: {
      baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    },
    modelId: 'Meta-Llama-3_3-70B-Instruct',
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Explain tool calling in one sentence.')
  console.log(response)
  // --8<-- [end:usage]
}
