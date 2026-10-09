import { Agent } from '@strands-agents/sdk'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { GoogleModel } from '@strands-agents/sdk/models/google'
import express, { type Request, type Response } from 'express'

async function chatServer() {
  // --8<-- [start:chat_server]
  const app = express()
  app.use(express.json())

  app.post('/chat', async (req: Request, res: Response) => {
    // The agent lives in this process: no scheduler or database to reach.
    const agent = new Agent()
    const result = await agent.invoke(req.body.prompt)
    res.json({ reply: result.lastMessage })
  })

  app.listen(3000)
  // --8<-- [end:chat_server]
}

async function providerBedrock() {
  // --8<-- [start:provider_bedrock]
  // Amazon Bedrock is the default, so no model object is required.
  const agent = new Agent()
  const result = await agent.invoke('What can you help me build?')
  console.log(result.lastMessage)
  // --8<-- [end:provider_bedrock]
}

async function providerAnthropic() {
  // --8<-- [start:provider_anthropic]
  const agent = new Agent({
    model: new AnthropicModel({ apiKey: '<KEY>', modelId: 'claude-sonnet-5' }),
  })
  const result = await agent.invoke('What can you help me build?')
  console.log(result.lastMessage)
  // --8<-- [end:provider_anthropic]
}

async function providerOpenAI() {
  // --8<-- [start:provider_openai]
  const agent = new Agent({
    model: new OpenAIModel({ apiKey: '<KEY>', modelId: 'gpt-5.4' }),
  })
  const result = await agent.invoke('What can you help me build?')
  console.log(result.lastMessage)
  // --8<-- [end:provider_openai]
}

async function providerGoogle() {
  // --8<-- [start:provider_google]
  const agent = new Agent({
    model: new GoogleModel({ apiKey: '<KEY>', modelId: 'gemini-2.5-flash' }),
  })
  const result = await agent.invoke('What can you help me build?')
  console.log(result.lastMessage)
  // --8<-- [end:provider_google]
}
