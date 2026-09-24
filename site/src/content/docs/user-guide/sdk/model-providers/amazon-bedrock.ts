/**
 * TypeScript examples for Amazon Bedrock model provider documentation.
 * These examples demonstrate common usage patterns for the BedrockModel.
 */
// @ts-nocheck
// Imports are in amazon-bedrock_imports.ts

import { Agent, BedrockModel, DocumentBlock } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { z } from 'zod'

// Basic usage examples
async function basicUsageDefault() {
  // --8<-- [start:basic_default]
  const agent = new Agent()

  const response = await agent.invoke('Tell me about Amazon Bedrock.')
  // --8<-- [end:basic_default]
}

async function basicUsageModelId() {
  // --8<-- [start:basic_model_id]
  // Create an agent using the model
  const agent = new Agent({ model: 'global.anthropic.claude-sonnet-5' })

  const response = await agent.invoke('Tell me about Amazon Bedrock.')
  // --8<-- [end:basic_model_id]
}

async function basicUsageModelInstance() {
  // --8<-- [start:basic_model_instance]
  // Create a Bedrock model instance
  const bedrockModel = new BedrockModel({
    modelId: 'us.amazon.nova-premier-v1:0',
    temperature: 0.3,
    topP: 0.8,
  })

  // Create an agent using the BedrockModel instance
  const agent = new Agent({ model: bedrockModel })

  // Use the agent
  const response = await agent.invoke('Tell me about Amazon Bedrock.')
  // --8<-- [end:basic_model_instance]
}

// Configuration example
async function configurationExample() {
  // --8<-- [start:configuration]
  // Create a configured Bedrock model
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    region: 'us-east-1', // Specify a different region than the default
    temperature: 0.3,
    stopSequences: ['###', 'END'],
    clientConfig: {
      retryMode: 'standard',
      maxAttempts: 3,
    },
  })

  // Create an agent with the configured model
  const agent = new Agent({ model: bedrockModel })

  // Use the agent
  const response = await agent.invoke('Write a short story about an AI assistant.')
  // --8<-- [end:configuration]
}

// Streaming vs non-streaming
async function streamingExample() {
  // --8<-- [start:streaming]
  // Streaming model (default)
  const streamingModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    stream: true, // This is the default
  })

  // Non-streaming model
  const nonStreamingModel = new BedrockModel({
    modelId: 'us.meta.llama3-2-90b-instruct-v1:0',
    stream: false, // Disable streaming
  })
  // --8<-- [end:streaming]
}

// Update configuration at runtime
async function updateConfiguration() {
  // --8<-- [start:update_config]
  // Create the model with initial configuration
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    temperature: 0.7,
  })

  // Update configuration later
  bedrockModel.updateConfig({
    temperature: 0.3,
  })
  // --8<-- [end:update_config]
}

// Tool-based configuration update
async function toolBasedConfigUpdate() {
  // --8<-- [start:tool_update_config]
  // Define a tool that updates model configuration
  const updateTemperature = tool({
    name: 'update_temperature',
    description: 'Update the temperature of the agent',
    inputSchema: z.object({
      temperature: z.number().describe('Temperature value for the model to use'),
    }),
    callback: async ({ temperature }, context) => {
      if (context.agent?.model && 'updateConfig' in context.agent.model) {
        context.agent.model.updateConfig({ temperature })
        return `Temperature updated to ${temperature}`
      }
      return 'Failed to update temperature'
    },
  })

  const agent = new Agent({
    model: new BedrockModel({ modelId: 'global.anthropic.claude-sonnet-5' }),
    tools: [updateTemperature],
  })
  // --8<-- [end:tool_update_config]
}

// Reasoning support
async function reasoningSupport() {
  // --8<-- [start:reasoning]
  // Create a Bedrock model with reasoning configuration
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    additionalRequestFields: {
      thinking: {
        type: 'enabled',
        budget_tokens: 4096, // Minimum of 1,024
      },
    },
  })

  // Create an agent with the reasoning-enabled model
  const agent = new Agent({ model: bedrockModel })

  // Ask a question that requires reasoning
  const response = await agent.invoke(
    'If a train travels at 120 km/h and needs to cover 450 km, how long will the journey take?'
  )
  // --8<-- [end:reasoning]
}

// Custom credentials configuration
async function customCredentials() {
  // --8<-- [start:custom_credentials]
  // AWS credentials are configured through the clientConfig parameter
  // See AWS SDK for JavaScript documentation for all credential options:
  // https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html

  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    region: 'us-west-2',
    clientConfig: {
      credentials: {
        accessKeyId: 'your_access_key',
        secretAccessKey: 'your_secret_key',
        sessionToken: 'your_session_token', // If using temporary credentials
      },
    },
  })
  // --8<-- [end:custom_credentials]
}

// Multimodal support
async function multimodalSupport() {
  // --8<-- [start:multimodal_full]
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
  })

  const agent = new Agent({ model: bedrockModel })

  const documentBytes = Buffer.from('Once upon a time...')

  // Send multimodal content directly to invoke
  const response = await agent.invoke([
    new DocumentBlock({
      format: 'txt',
      name: 'example',
      source: { bytes: documentBytes },
    }),
    'Tell me about the document.',
  ])
  // --8<-- [end:multimodal_full]
}

// S3 location support for multimodal content
async function s3LocationSupport() {
  // --8<-- [start:s3_location]
  const agent = new Agent({ model: new BedrockModel() })

  const response = await agent.invoke([
    new DocumentBlock({
      format: 'pdf',
      name: 'report.pdf',
      source: {
        location: {
          type: 's3',
          uri: 's3://my-bucket/documents/report.pdf',
          bucketOwner: '123456789012', // Optional: for cross-account access
        },
      },
    }),
    'Summarize this document.',
  ])
  // --8<-- [end:s3_location]
}

// Guardrails configuration
async function guardrailsExample() {
  // --8<-- [start:guardrails]
  // Using guardrails with BedrockModel
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    guardrailConfig: {
      guardrailIdentifier: 'your-guardrail-id',
      guardrailVersion: 'DRAFT',
      trace: 'enabled', // Options: 'enabled', 'disabled', 'enabled_full'
      streamProcessingMode: 'sync', // Options: 'sync', 'async'
      redaction: {
        input: true, // Default: true
        inputMessage: '[User input redacted.]', // Custom redaction message
        output: false, // Default: false
        outputMessage: '[Assistant output redacted.]', // Custom redaction message
      },
      guardLatestUserMessage: true, // Only evaluate the latest user message (default: false)
    },
  })

  const guardrailAgent = new Agent({ model: bedrockModel })

  const response = await guardrailAgent.invoke('Can you tell me about the Strands Harness SDK?')
  // --8<-- [end:guardrails]
}

async function requestTimeoutExample() {
  // --8<-- [start:request_timeout]
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    requestTimeout: 600_000, // 10 minutes
  })
  // --8<-- [end:request_timeout]
  void bedrockModel
}

void requestTimeoutExample

async function requestTimeoutHandlerOptionsExample() {
  // --8<-- [start:request_timeout_handler_options]
  const bedrockModel = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-5',
    clientConfig: {
      requestHandler: { requestTimeout: 600_000, connectionTimeout: 5_000 },
    },
  })
  // --8<-- [end:request_timeout_handler_options]
  void bedrockModel
}

void requestTimeoutHandlerOptionsExample

async function structuredOutputExample() {
  // --8<-- [start:structured_output]
  const ProductAnalysis = z.object({
    name: z.string().describe('Product name'),
    category: z.string().describe('Product category'),
    price: z.number().describe('Price in USD'),
    features: z.array(z.string()).describe('Key product features'),
    rating: z.number().min(1).max(5).optional().describe('Customer rating 1-5'),
  })

  const bedrockModel = new BedrockModel()
  const agent = new Agent({
    model: bedrockModel,
    structuredOutputSchema: ProductAnalysis,
  })

  const result = await agent.invoke(
    `Analyze this product: The UltraBook Pro is a premium laptop computer
     priced at $1,299. It features a 15-inch 4K display, 16GB RAM, 512GB SSD,
     and 12-hour battery life. Customer reviews average 4.5 stars.`
  )

  const product = result.structuredOutput as z.infer<typeof ProductAnalysis>
  console.log(`Product: ${product.name}`)
  console.log(`Category: ${product.category}`)
  console.log(`Price: $${product.price}`)
  console.log(`Features: ${product.features.join(', ')}`)
  console.log(`Rating: ${product.rating}`)
  // --8<-- [end:structured_output]
}

void structuredOutputExample

// OpenAI-compatible endpoints (Mantle)
async function bedrockMantle() {
  // --8<-- [start:bedrock_mantle]
  const region = 'us-east-1'
  const model = new OpenAIModel({
    modelId: 'openai.gpt-oss-120b',
    apiKey: '<BEDROCK_API_KEY>',
    clientConfig: {
      baseURL: `https://bedrock-mantle.${region}.api.aws/v1`,
    },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2?')
  console.log(response)
  // --8<-- [end:bedrock_mantle]
}

// Mantle via bedrockMantleConfig
async function bedrockMantleConfig() {
  // --8<-- [start:mantle_config]
  const model = new OpenAIModel({
    modelId: 'openai.gpt-oss-120b',
    bedrockMantleConfig: { region: 'us-east-1' },
  })

  const agent = new Agent({ model })
  const response = await agent.invoke('What is 2+2?')
  console.log(response)
  // --8<-- [end:mantle_config]
}
