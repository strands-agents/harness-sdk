Amazon Bedrock gives an agent access to foundation models from several providers through one AWS API. Strands connects to Bedrock through the `BedrockModel` class, which is the default model provider when you create an `Agent` without specifying one.

This page covers running an agent on Bedrock: configuring AWS credentials, selecting a model, and setting the options `BedrockModel` exposes. `BedrockModel` supports:

-   Text generation
-   Multimodal input (images, documents, and more)
-   Tool calling
-   Guardrails
-   Prompt caching for system prompts, tools, and messages

## Getting Started

### Prerequisites

1.  **AWS Account**: You need an AWS account with access to Amazon Bedrock
2.  **AWS Credentials**: Configure AWS credentials with appropriate permissions

#### Required IAM Permissions

To use Amazon Bedrock with Strands, your IAM user or role needs the following permissions:

-   `bedrock:InvokeModelWithResponseStream` (for streaming mode)
-   `bedrock:InvokeModel` (for non-streaming mode)

Here’s a sample IAM policy that grants the necessary permissions:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:InvokeModel"
            ],
            "Resource": "*"
        }
    ]
}
```

For production, scope the `Resource` down to specific model ARNs.

#### Setting Up AWS Credentials

(( tab "Python" ))
Strands uses [boto3](https://boto3.amazonaws.com/v1/documentation/api/latest/index.html) (the AWS SDK for Python) to make calls to Amazon Bedrock. Boto3 has its own credential resolution system that determines which credentials to use when making requests to AWS.

For development environments, configure credentials using one of these methods:

**Option 1: AWS CLI**

```bash
aws configure
```

**Option 2: Environment Variables**

```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_SESSION_TOKEN=your_session_token  # If using temporary credentials
export AWS_REGION="us-west-2"  # Used if a custom Boto3 Session is not provided
```

Region Resolution Priority

Due to boto3’s behavior, the region resolution follows this priority order:

1.  Region explicitly passed to `BedrockModel(region_name="...")`
2.  Region from boto3 session (AWS\_DEFAULT\_REGION or profile region from ~/.aws/config)
3.  AWS\_REGION environment variable
4.  Default region (us-west-2)

This means `AWS_REGION` has lower priority than regions set in AWS profiles. If you’re experiencing unexpected region behavior, check your AWS configuration files and consider using `AWS_DEFAULT_REGION` or explicitly passing `region_name` to the BedrockModel constructor.

For more details, see the [boto3 issue discussion](https://github.com/boto/boto3/issues/2574).

**Option 3: Custom Boto3 Session**

You can configure a custom [boto3 Session](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/core/session.html) and pass it to the `BedrockModel`:

```python
import boto3
from strands.models import BedrockModel

# Create a custom boto3 session
session = boto3.Session(
    aws_access_key_id='your_access_key',
    aws_secret_access_key='your_secret_key',
    aws_session_token='your_session_token',  # If using temporary credentials
    region_name='us-west-2',
    profile_name='your-profile'  # Optional: Use a specific profile
)

# Create a Bedrock model with the custom session
bedrock_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    boto_session=session
)
```

For complete details on credential configuration and resolution, see the [boto3 credentials documentation](https://boto3.amazonaws.com/v1/documentation/api/latest/guide/credentials.html#configuring-credentials).

**Option 4: aws login**

`aws login` provides browser-based authentication for temporary credentials. Requires AWS CLI version 2.32.0 or later.

```bash
aws login
```

To use `aws login` with enhanced performance, install botocore with CRT support:

```bash
pip install botocore[crt]
```

See the [Login for AWS local development using console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html) documentation for more details.
(( /tab "Python" ))

(( tab "TypeScript" ))
The TypeScript SDK uses the [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/welcome.html) to make calls to Amazon Bedrock. The SDK has its own credential resolution system that determines which credentials to use when making requests to AWS.

For development environments, configure credentials using one of these methods:

**Option 1: AWS CLI**

```bash
aws configure
```

**Option 2: Environment Variables**

```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_SESSION_TOKEN=your_session_token  # If using temporary credentials
export AWS_REGION="us-west-2"
```

**Option 3: Custom Credentials**

```typescript
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

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
```

For complete details on credential configuration, see the [AWS SDK for JavaScript documentation](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).
(( /tab "TypeScript" ))

## Basic Usage

(( tab "Python" ))
A basic `Agent` uses the [`BedrockModel`](/docs/api/python/strands.models.bedrock) provider with [Claude Sonnet 4.6](https://www.anthropic.com/claude/sonnet) by default:

```python
from strands import Agent

agent = Agent()

response = agent("Tell me about Amazon Bedrock.")
```

You can specify which Bedrock model to use by passing in the model ID string directly to the Agent constructor:

```python
from strands import Agent

# Create an agent with a specific model by passing the model ID string
agent = Agent(model="global.anthropic.claude-sonnet-5")

response = agent("Tell me about Amazon Bedrock.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
A basic `Agent` uses the [`BedrockModel`](/docs/api/typescript/BedrockModel/index.md) provider with [Claude Sonnet 4.6](https://www.anthropic.com/claude/sonnet) by default:

```typescript
import { Agent } from '@strands-agents/sdk'

const agent = new Agent()

const response = await agent.invoke('Tell me about Amazon Bedrock.')
```

You can specify which Bedrock model to use by passing in the model ID string directly to the Agent constructor:

```typescript
import { Agent } from '@strands-agents/sdk'

// Create an agent using the model
const agent = new Agent({ model: 'global.anthropic.claude-sonnet-5' })

const response = await agent.invoke('Tell me about Amazon Bedrock.')
```
(( /tab "TypeScript" ))

> **Note:** See [Bedrock troubleshooting](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md#troubleshooting) if you encounter any issues.

### Custom Configuration

(( tab "Python" ))
For more control over model configuration, you can create an instance of the [`BedrockModel`](/docs/api/python/strands.models.bedrock) class:

```python
from strands import Agent
from strands.models import BedrockModel

# Create a Bedrock model instance
bedrock_model = BedrockModel(
    model_id="us.amazon.nova-premier-v1:0",
    temperature=0.3,
    top_p=0.8,
)

# Create an agent using the BedrockModel instance
agent = Agent(model=bedrock_model)

# Use the agent
response = agent("Tell me about Amazon Bedrock.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
For more control over model configuration, you can create an instance of the [`BedrockModel`](/docs/api/typescript/BedrockModel/index.md) class:

```typescript
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
```
(( /tab "TypeScript" ))

## Configuration Options

(( tab "Python" ))
The [`BedrockModel`](/docs/api/python/strands.models.bedrock) supports various configuration parameters. For a complete list of available options, see the [BedrockModel API reference](/docs/api/python/strands.models.bedrock).

Common configuration parameters include:

-   `model_id` - The Bedrock model identifier
-   `temperature` - Controls randomness (higher = more random)
-   `max_tokens` - Maximum number of tokens to generate; defaults to the model’s known output limit (`get_config()` shows the value); pass `None` to leave it unset. Bedrock reserves `input + max_tokens` against your tokens-per-minute quota when a request starts, so set it explicitly for high-concurrency workloads
-   `streaming` - Enable/disable streaming mode
-   `guardrail_id` - ID of the guardrail to apply
-   `cache_prompt` - Cache point type for the system prompt (deprecated, use `cache_config`)
-   `cache_config` - Configuration for prompt caching (e.g., `CacheConfig(strategy="auto")`)
-   `cache_tools` - Enable tool caching (deprecated, use `cache_config` with `CacheConfig(tools_ttl=...)`)
-   `strict_tools` - Enforce structured output on tool definitions. Bedrock’s strict mode restricts which JSON Schema features tool input schemas may use (for example, `oneOf` is unsupported), so a schema that uses an unsupported feature fails at request time. See the [Bedrock structured output documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
-   `boto_session` - Custom boto3 session for AWS credentials
-   `api_key` - Amazon Bedrock API key for bearer token authentication; requests use the key instead of SigV4 signing
-   `additional_request_fields` - Additional model-specific parameters
(( /tab "Python" ))

(( tab "TypeScript" ))
The [`BedrockModel`](/docs/api/typescript/BedrockModelOptions/index.md) supports various configuration parameters. For a complete list of available options, see the [BedrockModelOptions API reference](/docs/api/typescript/BedrockModelOptions/index.md).

Common configuration parameters include:

-   `modelId` - The Bedrock model identifier
-   `temperature` - Controls randomness (higher = more random)
-   `maxTokens` - Maximum number of tokens to generate; defaults to the model’s known output limit (`getConfig()` shows the value). Bedrock reserves `input + maxTokens` against your tokens-per-minute quota when a request starts, so set it explicitly for high-concurrency workloads
-   `stream` - Enable/disable streaming mode
-   `cacheConfig` - Enable prompt caching with `{ strategy: 'auto' }`, or `{ messagesTTL: false }` to cache the tool definitions and system prompt only
-   `region` - AWS region to use
-   `apiKey` - Bedrock API key for bearer token authentication (alternative to SigV4 signing)
-   `clientConfig` - AWS SDK client configuration
-   `additionalArgs` - Additional model-specific parameters
(( /tab "TypeScript" ))

### Example with Configuration

(( tab "Python" ))
```python
from strands import Agent
from strands.models import BedrockModel
from botocore.config import Config as BotocoreConfig

# Create a boto client config with custom settings
boto_config = BotocoreConfig(
    retries={"max_attempts": 3, "mode": "standard"},
    connect_timeout=5,
    read_timeout=60
)

# Create a configured Bedrock model
bedrock_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    region_name="us-east-1",  # Specify a different region than the default
    temperature=0.3,
    stop_sequences=["###", "END"],
    boto_client_config=boto_config,
)

# Create an agent with the configured model
agent = Agent(model=bedrock_model)

# Use the agent
response = agent("Write a short story about an AI assistant.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
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
```
(( /tab "TypeScript" ))

#### TypeScript Request Timeout

The TypeScript SDK applies a default `requestTimeout` of 120000 ms (120 seconds) when constructing the Bedrock Runtime client, since the underlying AWS SDK defaults to `0` (disabled), which lets a stuck connection hang. The timeout counts stream inactivity, so a long-thinking model or a large tool-call payload that keeps the stream quiet past the limit fails with `Stream timed out because of no activity`. Raise it with the `requestTimeout` option:

```typescript
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

const bedrockModel = new BedrockModel({
  modelId: 'global.anthropic.claude-sonnet-5',
  requestTimeout: 600_000, // 10 minutes
})
```

The same value can also be set through `clientConfig.requestHandler` alongside other handler options; when both are given, the top-level `requestTimeout` wins:

```typescript
const bedrockModel = new BedrockModel({
  modelId: 'global.anthropic.claude-sonnet-5',
  clientConfig: {
    requestHandler: { requestTimeout: 600_000, connectionTimeout: 5_000 },
  },
})
```

Passing a fully-constructed handler instance (rather than an options bag) bypasses both; the handler’s own timeouts apply unchanged and a `requestTimeout` option is ignored with a warning.

## Advanced Features

### Streaming vs Non-Streaming Mode

Some Bedrock models only support non-streaming tool use. Set the streaming configuration to false to use those models. Both modes give your agent the same event structure and behavior, since Strands converts non-streaming responses to the streaming format internally.

(( tab "Python" ))
```python
# Streaming model (default)
streaming_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    streaming=True,  # This is the default
)

# Non-streaming model
non_streaming_model = BedrockModel(
    model_id="us.meta.llama3-2-90b-instruct-v1:0",
    streaming=False,  # Disable streaming
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
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
```
(( /tab "TypeScript" ))

See the Amazon Bedrock documentation for [Supported models and model features](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html) to learn about the streaming support for different models.

### Multimodal Support

Some Bedrock models accept multimodal input such as documents, images, and audio. Pass the content blocks directly to the agent:

(( tab "Python" ))
```python
from strands import Agent
from strands.models import BedrockModel

# Create a Bedrock model that supports multimodal inputs
bedrock_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5"
)
agent = Agent(model=bedrock_model)

# Send the multimodal message to the agent
response = agent(
    [
        {
            "document": {
                "format": "txt",
                "name": "example",
                "source": {
                    "bytes": b"Once upon a time..."
                }
            }
        },
        {
            "text": "Tell me about the document."
        }
    ]
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
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
```
(( /tab "TypeScript" ))

For the full list of input types, see the [API Reference](/docs/api/python/strands.types.content).

#### S3 Location Support

As an alternative to providing media content as bytes, Amazon Bedrock supports referencing documents, images, videos, and audio stored in Amazon S3 directly. This is useful when working with large files or when your content is already stored in S3.

IAM Permissions Required

To use S3 locations, the IAM role or user making the Bedrock API call must have `s3:GetObject` permission on the S3 bucket and objects being referenced.

(( tab "Python" ))
```python
from strands import Agent
from strands.models import BedrockModel

agent = Agent(model=BedrockModel())

response = agent(
    [
        {
            "document": {
                "format": "pdf",
                "name": "report.pdf",
                "source": {
                    "location": {
                        "type": "s3",
                        "uri": "s3://my-bucket/documents/report.pdf",
                        "bucketOwner": "123456789012"  # Optional: for cross-account access
                    }
                }
            }
        },
        {
            "text": "Summarize this document."
        }
    ]
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
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
```
(( /tab "TypeScript" ))

Supported Media Types

The same `location` pattern also works for images, videos, and audio.

### Guardrails

(( tab "Python" ))
Configure a [guardrail](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) on your [`BedrockModel`](/docs/api/python/strands.models.bedrock) to keep model output within your policies:

```python
from strands import Agent
from strands.models import BedrockModel

# Using guardrails with BedrockModel
bedrock_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    guardrail_id="your-guardrail-id",
    guardrail_version="DRAFT",
    guardrail_trace="enabled",  # Options: "enabled", "disabled", "enabled_full"
    guardrail_stream_processing_mode="sync",  # Options: "sync", "async"
    guardrail_redact_input=True,  # Default: True
    guardrail_redact_input_message="Blocked Input!", # Default: [User input redacted.]
    guardrail_redact_output=False,  # Default: False
    guardrail_redact_output_message="Blocked Output!", # Default: [Assistant output redacted.]
    guardrail_latest_message=True,  # Only evaluate the latest user message (default: False)
)

guardrail_agent = Agent(model=bedrock_model)

response = guardrail_agent("Can you tell me about the Strands Harness SDK?")
```

When a guardrail is triggered:

-   Input redaction (enabled by default): If a guardrail policy is triggered, the input is redacted
-   Output redaction (disabled by default): If a guardrail policy is triggered, the output is redacted
-   Custom redaction messages can be specified for both input and output redactions

Latest Message Evaluation

When `guardrail_latest_message=True`, only the most recent user message is sent to guardrails for evaluation instead of the entire conversation. This can improve performance and reduce costs in multi-turn conversations where earlier messages have already been validated.
(( /tab "Python" ))

(( tab "TypeScript" ))
Configure a [guardrail](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html) on your [`BedrockModel`](/docs/api/typescript/BedrockModel/index.md) to keep model output within your policies:

```typescript
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

const response = await guardrailAgent.invoke(
  'Can you tell me about the Strands Harness SDK?'
)
```

When a guardrail is triggered:

-   Input redaction (enabled by default): If a guardrail policy is triggered, the input is redacted
-   Output redaction (disabled by default): If a guardrail policy is triggered, the output is redacted
-   Custom redaction messages can be specified for both input and output redactions

Latest Message Evaluation

When `guardLatestUserMessage: true`, only the most recent user message is sent to guardrails for evaluation instead of the entire conversation. This can improve performance and reduce costs in multi-turn conversations where earlier messages have already been validated.
(( /tab "TypeScript" ))

### Caching

Strands caches system prompts, tools, and messages on Bedrock to reduce token usage and latency. See [Bedrock prompt caching](/docs/user-guide/sdk/model-providers/amazon-bedrock-prompt-caching/index.md) for automatic and manual cache point placement, per-model token minimums, and cache metrics.

### Updating Configuration at Runtime

You can update the model configuration during runtime:

(( tab "Python" ))
```python
# Create the model with initial configuration
bedrock_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    temperature=0.7
)

# Update configuration later
bedrock_model.update_config(
    temperature=0.3,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Create the model with initial configuration
const bedrockModel = new BedrockModel({
  modelId: 'global.anthropic.claude-sonnet-5',
  temperature: 0.7,
})

// Update configuration later
bedrockModel.updateConfig({
  temperature: 0.3,
})
```
(( /tab "TypeScript" ))

This is especially useful for tools that need to update the model’s configuration:

(( tab "Python" ))
```python
@tool
def update_model_id(model_id: str, agent: Agent) -> str:
    """
    Update the model id of the agent

    Args:
      model_id: Bedrock model id to use.
    """
    print(f"Updating model_id to {model_id}")
    agent.model.update_config(model_id=model_id)
    return f"Model updated to {model_id}"


@tool
def update_temperature(temperature: float, agent: Agent) -> str:
    """
    Update the temperature of the agent

    Args:
      temperature: Temperature value for the model to use.
    """
    print(f"Updating Temperature to {temperature}")
    agent.model.update_config(temperature=temperature)
    return f"Temperature updated to {temperature}"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'

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
```
(( /tab "TypeScript" ))

### Reasoning Support

Amazon Bedrock models can provide detailed reasoning steps when generating responses. For detailed information about supported models and reasoning token configuration, see the [Amazon Bedrock documentation on inference reasoning](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html).

(( tab "Python" ))
Enable reasoning on your [`BedrockModel`](/docs/api/python/strands.models.bedrock):

```python
from strands import Agent
from strands.models import BedrockModel

# Create a Bedrock model with reasoning configuration
bedrock_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    additional_request_fields={
        "thinking": {
            "type": "enabled",
            "budget_tokens": 4096 # Minimum of 1,024
        }
    }
)

# Create an agent with the reasoning-enabled model
agent = Agent(model=bedrock_model)

# Ask a question that requires reasoning
response = agent("If a train travels at 120 km/h and needs to cover 450 km, how long will the journey take?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Enable reasoning on your [`BedrockModel`](/docs/api/typescript/BedrockModel/index.md):

```typescript
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
```
(( /tab "TypeScript" ))

> **Note**: Not all models support structured reasoning output. Check the [inference reasoning documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html) for details on supported models.

### Structured Output

Amazon Bedrock models support structured output through their tool calling capabilities. Pass a schema to the agent, and Strands converts it to Bedrock’s tool specification format and validates the response.

(( tab "Python" ))
Define a Pydantic model and pass it to `agent.structured_output()`:

```python
from pydantic import BaseModel, Field
from strands import Agent
from strands.models import BedrockModel
from typing import List, Optional

class ProductAnalysis(BaseModel):
    """Analyze product information from text."""
    name: str = Field(description="Product name")
    category: str = Field(description="Product category")
    price: float = Field(description="Price in USD")
    features: List[str] = Field(description="Key product features")
    rating: Optional[float] = Field(description="Customer rating 1-5", ge=1, le=5)

bedrock_model = BedrockModel()

agent = Agent(model=bedrock_model)

result = agent.structured_output(
    ProductAnalysis,
    """
    Analyze this product: The UltraBook Pro is a premium laptop computer
    priced at $1,299. It features a 15-inch 4K display, 16GB RAM, 512GB SSD,
    and 12-hour battery life. Customer reviews average 4.5 stars.
    """
)

print(f"Product: {result.name}")
print(f"Category: {result.category}")
print(f"Price: ${result.price}")
print(f"Features: {result.features}")
print(f"Rating: {result.rating}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Define a Zod schema and pass it as `structuredOutputSchema`. Validated output is on `result.structuredOutput`:

```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { z } from 'zod'

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
```
(( /tab "TypeScript" ))

For schema patterns, error handling, and per-invocation overrides, see [Structured Output](/docs/user-guide/sdk/agents/structured-output/index.md).

### Token Counting

Context management uses token counting to estimate input tokens before each model call.

(( tab "Python" ))
The Bedrock provider can use the native `count_tokens` API via the `CountTokens` action in the Converse API. This includes system prompts, messages, and tool specifications in the count.

Not all Bedrock models support the `CountTokens` API. When a model doesn’t support it or the caller doesn’t have the required IAM permissions, the provider caches this result and falls back to estimation with a character-based heuristic (characters ÷ 4 for text, characters ÷ 2 for JSON) for subsequent calls.

You can enable native token counting with:

```python
model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-5",
    use_native_token_count=True,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
The Bedrock provider can use the native `CountTokensCommand` API. This includes system prompts, messages, and tool specifications in the count.

Not all Bedrock models support the `CountTokens` API. When a model doesn’t support it or the caller doesn’t have the required IAM permissions, the provider caches this result and falls back to estimation with a character-based heuristic (characters ÷ 4 for text, characters ÷ 2 for JSON) for subsequent calls.

You can enable native token counting with:

```typescript
const model = new BedrockModel({
  modelId: 'global.anthropic.claude-sonnet-5',
  useNativeTokenCount: true,
})
```
(( /tab "TypeScript" ))

### OpenAI-Compatible Endpoints (Mantle)

Mantle is not a separate service or model catalog: it is Amazon Bedrock’s second endpoint family, [`bedrock-mantle`](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html), which serves Bedrock-hosted models through OpenAI-compatible APIs. The two families serve different, overlapping model sets: many models are only on the standard `bedrock-runtime` endpoint that `BedrockModel` uses, some model lines are only on `bedrock-mantle`, and some are on both. AWS lists which endpoint serves each model in [endpoint availability by model](https://docs.aws.amazon.com/bedrock/latest/userguide/models-endpoint-availability.html).

Pick your provider by where the model is served. When it is on `bedrock-runtime`, use `BedrockModel` as described on the rest of this page (AWS recommends that endpoint when a model is on both). When it is served through Mantle, connect with the SDK’s [OpenAI Responses provider](/docs/user-guide/sdk/model-providers/openai-responses/index.md) instead, in one of the two ways below. In Python, that provider can also target `bedrock-runtime`; see [Choosing the Endpoint](#choosing-the-endpoint).

#### Connecting with AWS Credentials

Pass `bedrock_mantle_config``bedrockMantleConfig` and the provider derives the endpoint from your region, routes the model to the correct Mantle base path, and mints short-lived bearer tokens from your AWS credentials (via the standard credential chain), refreshing them so long-running agents survive token expiry:

(( tab "Python" ))
```python
from strands import Agent
from strands.models.openai_responses import OpenAIResponsesModel

model = OpenAIResponsesModel(
    model_id="openai.gpt-oss-120b",
    bedrock_mantle_config={"region": "us-east-1"},
)

agent = Agent(model=model)
response = agent("What is 2+2?")
print(response)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

const model = new OpenAIModel({
  modelId: 'openai.gpt-oss-120b',
  bedrockMantleConfig: { region: 'us-east-1' },
})

const agent = new Agent({ model })
const response = await agent.invoke('What is 2+2?')
console.log(response)
```

Requires the optional dependency: `npm install @aws/bedrock-token-generator`
(( /tab "TypeScript" ))

Omit the region to resolve it from your AWS environment. The config also accepts AWS credentials to forward to the token generator (`credentials_provider``credentials`, a botocore CredentialProviderstatic identity or provider function) and a token-lifetime override (`expiry``expiresInSeconds`). In Python, `boto_session` can also supply the region from a configured profile.

#### Choosing the Endpoint

The config targets `bedrock-mantle` by default. In Python, set `endpoint` to `bedrock-runtime`, which is where the OpenAI GPT models are served through [cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) profile ids such as `global.openai.gpt-5.6-luna`:

(( tab "Python" ))
```python
from strands import Agent
from strands.models.openai_responses import OpenAIResponsesModel

model = OpenAIResponsesModel(
    model_id="global.openai.gpt-5.6-luna",
    bedrock_mantle_config={"endpoint": "bedrock-runtime", "region": "us-east-1"},
)

agent = Agent(model=model)
response = agent("What is 2+2?")
print(response)
```
(( /tab "Python" ))

AWS compares what the two endpoints support in [endpoints supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html).

#### Connecting with a Bedrock API Key

Authenticate with a [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-key-management.html) and point the client at your region’s Mantle endpoint yourself. Note that some model lines are served from `/openai/v1` rather than `/v1`; the config-based approach above picks the right path for you.

(( tab "Python" ))
```python
from strands import Agent
from strands.models.openai_responses import OpenAIResponsesModel

region = "us-east-1"
model = OpenAIResponsesModel(
    model_id="openai.gpt-oss-120b",
    client_args={
        "api_key": "<BEDROCK_API_KEY>",
        "base_url": f"https://bedrock-mantle.{region}.api.aws/v1",
    },
)

agent = Agent(model=model)
response = agent("What is 2+2?")
print(response)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

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
```
(( /tab "TypeScript" ))

## Troubleshooting

### On-demand throughput isn’t supported

If you encounter the error:

> Invocation of model ID XXXX with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.

This typically indicates that the model requires Cross-Region Inference, as documented in the [Amazon Bedrock documentation on inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html#inference-profiles-support-system). To resolve this issue, prefix your model ID with the appropriate regional identifier (`us.`or `eu.`) based on where your agent is running. For example:

Instead of:

```plaintext
anthropic.claude-sonnet-5
```

Use:

```plaintext
us.anthropic.claude-sonnet-5
```

### Model identifier is invalid

If you encounter the error:

> ValidationException: An error occurred (ValidationException) when calling the ConverseStream operation: The provided model identifier is invalid

This is very likely due to calling Bedrock with an inference model id, such as: `us.anthropic.claude-sonnet-5` from a region that does not [support inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html). If so, pass in a valid model id, as follows:

(( tab "Python" ))
```python
agent = Agent(model="anthropic.claude-3-5-sonnet-20241022-v2:0")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent({
  model: 'anthropic.claude-3-5-sonnet-20241022-v2:0'
})
```
(( /tab "TypeScript" ))

Default Inference Model

Strands uses a default Claude 4 Sonnet inference model from the region of your credentials when no model is provided. So if you did not pass in any model id and are getting the above error, it’s very likely due to the `region` from the credentials not supporting inference profiles.

### CacheConfig with ARN-based inference profiles

If you’re using an ARN-based application inference profile as your `model_id` (e.g., `arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123`), `CacheConfig(strategy="auto")` will not automatically enable prompt caching.

The `strategy="auto"` detection checks the model ID string for `"claude"` or `"anthropic"` substrings. Cross-region inference profile IDs like `us.anthropic.claude-sonnet-5` contain `"anthropic"` and are detected correctly, but application inference profiles use opaque resource IDs (`application-inference-profile/abc123`) that carry no model name information, so detection returns `None`, caching is skipped, and Strands logs a warning: `model_id=<your-arn> | cache_config is enabled but this model does not support automatic caching`.

Use `strategy="anthropic"` explicitly to fix this:

(( tab "Python" ))
```python
from strands import Agent
from strands.models import BedrockModel, CacheConfig

bedrock_model = BedrockModel(
    model_id="arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
    cache_config=CacheConfig(strategy="anthropic")
)

agent = Agent(model=bedrock_model)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

const bedrockModel = new BedrockModel({
  modelId: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123',
  cacheConfig: { strategy: 'anthropic' },
})

const agent = new Agent({ model: bedrockModel })
```
(( /tab "TypeScript" ))

`strategy="anthropic"` has identical performance to `strategy="auto"` and requires no additional API calls or IAM permissions.

### Thinking block is bound to a different conversation

When Amazon Bedrock rejects a request with this error:

> ValidationException: The block is bound to a different conversation.

The provider retries the request once and logs this warning:

```plaintext
model_id=<...> | history edit invalidated replayed thinking blocks, retrying with drop_block
```

Claude models that preserve thinking bind each thinking block to the conversation that came before it. Summarizing or removing messages with [context management](/docs/user-guide/sdk/context-management/index.md) or a conversation manager, restoring a session, or editing messages from a hook changes that earlier conversation, so the thinking blocks that remain in the history no longer match it. Accounts that enforce this binding, the default for accounts created on or after August 31, 2026, reject the next request.

The retry sets `prefix_mismatch_behavior` to `drop_block` in the `thinking.block_binding` request field and adds the `thinking-binding-controls-2026-08-01` beta to any betas already in `anthropic_beta`. Claude then skips the stale thinking blocks instead of rejecting the request. The stale blocks stay in the history, so the provider keeps sending `drop_block` for that model ID until the model instance is discarded. Requests before the first rejection are sent unchanged.

-   **Thinking must be configured.** The retry applies only when `thinking` is set in `additional_request_fields``additionalRequestFields`. Other errors, and this error without a thinking configuration, are raised as is.
-   **Your `block_binding` wins.** If the thinking configuration already contains `block_binding`, the provider sends it as written and does not retry. Set it yourself to choose the behavior up front or to keep the error.
-   **Dropping has a cost.** Claude loses the reasoning in the dropped blocks, the prompt cache restarts at the edited message, and responses can use more output tokens.
-   **Some models require adaptive thinking.** Claude Sonnet 5.5 and Claude Haiku 5.5 accept `drop_block` only with `"type": "adaptive"`. With any other thinking type, the retry fails and its error is raised.

## Related Resources

-   [Amazon Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
-   [Bedrock Model IDs Reference](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)
-   [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)

## Related pages

- [Amazon Nova](/docs/user-guide/sdk/model-providers/amazon-nova/index.md) (3 shared tags)
- [Guardrails](/docs/user-guide/sdk/safety-security/guardrails/index.md) (3 shared tags)
- [Bedrock Nova Sonic](/docs/user-guide/sdk/bidi/models/bedrock/index.md) (2 shared tags)
- [Bedrock Knowledge Base Store](/docs/user-guide/sdk/memory/bedrock-knowledge-base/index.md) (2 shared tags)
- [Deploying Strands Agents to Amazon Bedrock AgentCore Runtime](/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/index.md) (2 shared tags)
- [Python Deployment to Amazon Bedrock AgentCore Runtime](/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/python/index.md) (2 shared tags)
- [TypeScript Deployment to Amazon Bedrock AgentCore Runtime](/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/typescript/index.md) (2 shared tags)
- [AgentCore evaluations](/docs/user-guide/evals-sdk/how-to/agentcore_evaluation_dashboard/index.md) (2 shared tags)
- [PII Redaction](/docs/user-guide/sdk/safety-security/pii-redaction/index.md) (2 shared tags)
- [Result caching](/docs/user-guide/evals-sdk/how-to/result_caching/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/models/bedrock.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py)

### TypeScript

- [harness-sdk/strands-ts/src/models/bedrock.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts)
