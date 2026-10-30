// --8<-- [start:a2a_client_import]
import { Agent } from '@strands-agents/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client'
import { makeA2AClient } from '@strands-agents/sdk/vended-tools/a2a-client'
// --8<-- [end:a2a_client_import]
