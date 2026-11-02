import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client'
import { Agent } from '@strands-agents/sdk'
import { makeA2AClient } from '@strands-agents/sdk/vended-tools/a2a-client'

// A2A client example
async function a2aClientExample() {
  // --8<-- [start:a2a_client_example]
  const authFetch = createAuthenticatingFetchWithRetry(fetch, {
    headers: async () => ({ Authorization: 'Bearer your-token' }),
    shouldRetryWithHeaders: async () => undefined,
  })

  const a2aClient = makeA2AClient({
    allowedEndpoints: [
      // No auth needed
      'https://agent.example.com',
      // Custom ClientFactory for authenticated requests
      [
        'https://researcher.example.com',
        new ClientFactory({
          transports: [
            new JsonRpcTransportFactory({ fetchImpl: authFetch }),
            new RestTransportFactory({ fetchImpl: authFetch }),
          ],
          cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
        }),
      ],
    ],
  })

  const agent = new Agent({ tools: [a2aClient] })
  await agent.invoke('What has the research agent found recently?')
  // --8<-- [end:a2a_client_example]
}
