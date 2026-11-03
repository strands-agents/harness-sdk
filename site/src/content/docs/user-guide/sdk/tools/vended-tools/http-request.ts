import { Agent } from '@strands-agents/sdk'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

// HTTP request example
async function httpRequestExample() {
  // --8<-- [start:http_request_example]
  const agent = new Agent({
    tools: [httpRequest],
  })

  // Make API requests
  await agent.invoke('Get data from https://api.example.com/users')
  await agent.invoke('Post {"name": "John"} to https://api.example.com/users')
  // --8<-- [end:http_request_example]
}
