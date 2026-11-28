/**
 * TypeScript examples for the SageMaker model provider documentation.
 */

import { SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime'
import { Agent } from '@strands-agents/sdk'
import { SageMakerModel } from '@strands-agents/sdk/models/sagemaker'

async function basicUsage() {
  // --8<-- [start:basic_usage]
  const model = new SageMakerModel({
    endpointName: 'my-llm-endpoint',
    region: 'us-west-2',
    maxTokens: 1000,
    temperature: 0.7,
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What can you help me with?')
  // --8<-- [end:basic_usage]
  console.log(response)
}

async function customClient() {
  // --8<-- [start:custom_client]
  const client = new SageMakerRuntimeClient({ region: 'us-east-1', maxAttempts: 5 })

  const model = new SageMakerModel({
    endpointName: 'my-llm-endpoint',
    inferenceComponentName: 'my-component',
    client,
    maxTokens: 1000,
  })

  const agent = new Agent({ model })
  // --8<-- [end:custom_client]
  console.log(agent)
}

void basicUsage
void customClient
