import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { webFetch, makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

// Web fetch example
async function webFetchExample() {
  // --8<-- [start:web_fetch_example]
  const agent = new Agent({ tools: [webFetch] })
  await agent.invoke('Summarize https://example.com/blog/post')
  // --8<-- [end:web_fetch_example]
}

// Web fetch markdown mode example
async function webFetchMarkdownExample() {
  // --8<-- [start:web_fetch_markdown_example]
  const webFetch = makeWebFetch({ mode: 'markdown' })
  const agent = new Agent({ tools: [webFetch] })
  await agent.invoke('Read https://example.com/docs and explain the architecture')
  // --8<-- [end:web_fetch_markdown_example]
}

// Web fetch custom config example
async function webFetchCustomExample() {
  // --8<-- [start:web_fetch_custom_example]
  const webFetch = makeWebFetch({
    mode: 'agentic',
    maxBytes: 1 * 1024 * 1024,
    maxContentChars: 25_000,
    model: new BedrockModel({ modelId: 'us.amazon.nova-micro-v1:0' }),
  })
  const agent = new Agent({ tools: [webFetch] })
  // --8<-- [end:web_fetch_custom_example]
  void agent
}
