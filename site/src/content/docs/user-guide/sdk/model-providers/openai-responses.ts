/**
 * TypeScript examples for OpenAI Responses API documentation.
 */

import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

// Basic usage
{
  // --8<-- [start:basic_usage]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('Hello!')
  console.log(response)
  // --8<-- [end:basic_usage]
}

// Web search
{
  // --8<-- [start:web_search]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
    params: {
      tools: [{ type: 'web_search' }],
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What are the latest developments in AI?')
  // --8<-- [end:web_search]
}

// File search
{
  // --8<-- [start:file_search]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
    params: {
      tools: [
        {
          type: 'file_search',
          vector_store_ids: ['vs_abc123'],
        },
      ],
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What does the document say about pricing?')
  // --8<-- [end:file_search]
}

// Code interpreter
{
  // --8<-- [start:code_interpreter]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
    params: {
      tools: [
        {
          type: 'code_interpreter',
          container: { type: 'auto' },
        },
      ],
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke("Calculate the SHA-256 hash of 'hello world'")
  // --8<-- [end:code_interpreter]
}

// Remote MCP
{
  // --8<-- [start:remote_mcp]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
    params: {
      tools: [
        {
          type: 'mcp',
          server_label: 'deepwiki',
          server_url: 'https://mcp.deepwiki.com/mcp',
          require_approval: 'never',
        },
      ],
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke(
    'Using deepwiki, what language is the strands-agents/harness-sdk repo written in?'
  )
  // --8<-- [end:remote_mcp]
}

// Shell
{
  // --8<-- [start:shell]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
    params: {
      tools: [
        {
          type: 'shell',
          environment: { type: 'container_auto' },
        },
      ],
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke(
    'Use the shell to compute the md5sum of the string "hello world".'
  )
  // --8<-- [end:shell]
}

// Stateful conversation
{
  // --8<-- [start:stateful]
  const model = new OpenAIModel({
    modelId: 'gpt-4o',
    apiKey: '<KEY>',
    stateful: true,
  })

  const agent = new Agent({ model })
  await agent.invoke('My name is Alice.')
  // agent.messages is empty: state is on the server

  const response = await agent.invoke('What is my name?')
  // The model remembers "Alice" via server-side state
  // --8<-- [end:stateful]
}
