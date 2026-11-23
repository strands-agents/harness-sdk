## What are Model Providers?

A model provider is a service or platform that hosts and serves large language models through an API. The Strands Agents SDK is provider-agnostic: the same agent code runs against any supported provider, so you can switch providers or run several in one application without rewriting your agent. First-party providers include Amazon Bedrock, Anthropic, OpenAI, and Google; community packages add more, and the [custom provider interface](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) covers anything else.

## Provider capabilities

You get the same core behavior from every first-party provider, because each one reaches the agent through the same `Model` interface: streaming responses, tool calling, and structured output work the same way whichever provider you configure. Prompt caching is the capability that varies most, because it depends on the underlying model API.

| Provider | Streaming | Tool calling | Structured output | Prompt caching |
| --- | --- | --- | --- | --- |
| Amazon Bedrock | ✓ | ✓ | ✓ | ✓ |
| Anthropic | ✓ | ✓ | ✓ | ✓ |
| OpenAI | ✓ | ✓ | ✓ |  |
| OpenAI Responses | ✓ | ✓ | ✓ |  |
| Google | ✓ | ✓ | ✓ |  |
| Ollama | ✓ | ✓ | ✓ |  |
| LiteLLM | ✓ | ✓ | ✓ | ✓ |
| Mistral | ✓ | ✓ | ✓ |  |
| Llama API | ✓ | ✓ | ✓ |  |
| llama.cpp | ✓ | ✓ | ✓ | ✓ |
| SageMaker | ✓ | ✓ | ✓ |  |
| Vercel | ✓ | ✓ | ✓ | ✓ |
| Writer | ✓ | ✓ | ✓ |  |
| Custom provider | ✓ |  |  |  |

Streaming uses an async interface in both SDKs, so an async event stream is available wherever streaming is. The Python SDK implements structured output on each provider; the TypeScript SDK provides it at the agent layer for every provider. A custom provider implements the `Model` interface, where the streaming method is required and the other capabilities depend on your implementation.

Prompt caching is marked only where the provider writes cache points or cache control into the request: Amazon Bedrock, Anthropic, LiteLLM, llama.cpp (server-side prompt reuse), and Vercel (through the underlying provider). These rows were checked against each provider’s page in this section and the SDK model sources under `strands-py/src/strands/models/` and `strands-ts/src/models/`.

## How this compares to other frameworks

Provider-agnostic access can live at different layers of the stack. LiteLLM provides it at the client layer: one API in front of many model providers. Strands can use a LiteLLM deployment directly through the `LiteLLMModel` provider, so it becomes one more provider behind the same agent. Pydantic AI is a separate agent framework that, like Strands, runs the same agent code across multiple providers. The practical difference is scope: LiteLLM routes model calls and leaves the agent loop to you, while Pydantic AI and Strands each provide the loop, tool calling, and structured output around the model. For a side-by-side comparison of Strands against Pydantic AI and other frameworks, see [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md).

## Supported Providers

The following table shows all model providers supported by Strands Agents SDK and their availability in Python and TypeScript:

| Provider | Python Supported | TypeScript Supported |
| --- | --- | --- |
| [Amazon Bedrock](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md) | ✅ | ✅ |
| [Amazon Nova](/docs/user-guide/sdk/model-providers/amazon-nova/index.md) | ✅ | ❌ |
| [Anthropic](/docs/user-guide/sdk/model-providers/anthropic/index.md) | ✅ | ✅ |
| [Cohere](/docs/integrations/model-providers/cohere/index.md) | ✅ | ❌ |
| [Crusoe](/docs/integrations/model-providers/crusoe/index.md) | ✅ | ✅ |
| [Custom Providers](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) | ✅ | ✅ |
| [Fireworks AI](/docs/integrations/model-providers/fireworksai/index.md) | ✅ | ✅ |
| [Google](/docs/user-guide/sdk/model-providers/google/index.md) | ✅ | ✅ |
| [LiteLLM](/docs/user-guide/sdk/model-providers/litellm/index.md) | ✅ | ❌ |
| [llama.cpp](/docs/user-guide/sdk/model-providers/llamacpp/index.md) | ✅ | ❌ |
| [LlamaAPI](/docs/user-guide/sdk/model-providers/llamaapi/index.md) | ✅ | ❌ |
| [MistralAI](/docs/user-guide/sdk/model-providers/mistral/index.md) | ✅ | ❌ |
| [Nebius Token Factory](/docs/integrations/model-providers/nebius-token-factory/index.md) | ✅ | ✅ |
| [Ollama](/docs/user-guide/sdk/model-providers/ollama/index.md) | ✅ | ❌ |
| [OpenAI](/docs/user-guide/sdk/model-providers/openai/index.md) | ✅ | ✅ |
| [OpenAI Responses API](/docs/user-guide/sdk/model-providers/openai-responses/index.md) | ✅ | ✅ |
| [OpenRouter](/docs/integrations/model-providers/openrouter/index.md) | ✅ | ✅ |
| [OrcaRouter](/docs/integrations/model-providers/orcarouter/index.md) | ✅ | ✅ |
| [OVHcloud AI Endpoints](/docs/integrations/model-providers/ovhcloud-ai-endpoints/index.md) | ✅ | ✅ |
| [SageMaker](/docs/user-guide/sdk/model-providers/sagemaker/index.md) | ✅ | ❌ |
| [Vercel](/docs/user-guide/sdk/model-providers/vercel/index.md) | ❌ | ✅ |
| [Writer](/docs/user-guide/sdk/model-providers/writer/index.md) | ✅ | ❌ |

### Community providers

The following providers are built and maintained by the Strands community. Browse the [integrations page](/integrations/index.md) to explore additional community packages.

| Provider | Python Supported | TypeScript Supported |
| --- | --- | --- |
| [CLOVA Studio](/docs/integrations/model-providers/clova-studio/index.md) | ✅ | ❌ |
| [MLX](/docs/integrations/model-providers/mlx/index.md) | ✅ | ❌ |
| [NVIDIA NIM](/docs/integrations/model-providers/nvidia-nim/index.md) | ✅ | ❌ |
| [SGLang](/docs/integrations/model-providers/sglang/index.md) | ✅ | ❌ |
| [vLLM](/docs/integrations/model-providers/vllm/index.md) | ✅ | ❌ |
| [xAI](/docs/integrations/model-providers/xai/index.md) | ✅ | ❌ |

## Getting Started

### Installation

Most providers are available as optional dependencies. Install the provider you need:

(( tab "Python" ))
```bash
# Install with specific provider
pip install 'strands-agents[bedrock]'
pip install 'strands-agents[openai]'
pip install 'strands-agents[anthropic]'

# Or install with all providers
pip install 'strands-agents[all]'
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```bash
# Core SDK includes BedrockModel by default
npm install @strands-agents/sdk

# To use OpenAI, install the openai package
npm install openai
```

> **Note:** All model providers except Bedrock are listed as optional dependencies in the SDK. This means npm will attempt to install them automatically, but won’t fail if they’re unavailable. You can explicitly install them when needed.
(( /tab "TypeScript" ))

### Basic Usage

Every provider follows the same initialization pattern, so you switch providers by swapping the model instance:

(( tab "Python" ))
```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.models.openai import OpenAIModel

# Use Bedrock
bedrock_model = BedrockModel()
agent = Agent(model=bedrock_model)
response = agent("What can you help me with?")

# Alternatively, use OpenAI by just switching model provider
openai_model = OpenAIModel(
    client_args={"api_key": "<KEY>"},
    model_id="gpt-4o"
)
agent = Agent(model=openai_model)
response = agent("What can you help me with?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'

// Use Bedrock
const bedrockModel = new BedrockModel()
let agent = new Agent({ model: bedrockModel })
let response = await agent.invoke('What can you help me with?')

// Alternatively, use OpenAI by just switching model provider
const openaiModel = new OpenAIModel({
  api: 'chat',
  apiKey: process.env.OPENAI_API_KEY,
  modelId: 'gpt-5.4',
})
agent = new Agent({ model: openaiModel })
response = await agent.invoke('What can you help me with?')
```
(( /tab "TypeScript" ))

### Auxiliary model

Besides the main loop, the SDK makes side calls on your behalf: conversation-manager summarization, memory extraction, the human-in-the-loop risk classifier, LLM steering, the goal-loop judge, and the `web_fetch` analyst. By default they all run on the agent’s main model. Set `aux_model``auxModel` to route every one of them to a smaller, cheaper model at once:

(( tab "Python" ))
```python
from strands import Agent
from strands.models.bedrock import BedrockModel

agent = Agent(
    model=BedrockModel(model_id="global.anthropic.claude-opus-5-20260301-v1:0"),
    aux_model=BedrockModel(model_id="global.anthropic.claude-haiku-4-5-20251001-v1:0"),
    context_manager="auto",
)

# A string is a Bedrock model id, like `model`; assign later to change it.
agent.aux_model = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

const agent = new Agent({
  model: new BedrockModel({ modelId: 'global.anthropic.claude-opus-5-20260301-v1:0' }),
  auxModel: new BedrockModel({
    modelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  }),
  contextManager: 'auto',
})

// A string is a Bedrock model id, like `model`; assign later to change it.
agent.auxModel = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
```
(( /tab "TypeScript" ))

Each side call resolves its model in this order: the component’s own `model` option (for example the summarizer’s or the classifier’s) > `agent.aux_model``agent.auxModel` > `agent.model`. Leaving `aux_model``auxModel` unset changes nothing. A `ModelRouter` is not accepted here: side calls run outside the agent loop the router attaches to.

The context manager’s [summarize strategy](/docs/user-guide/sdk/context-management/custom-strategies/index.md#summarize) is the exception: its summaries replay the agent’s conversation, so it runs on `agent.model` unless you pass it its own `model`.

### Model info

When the SDK can’t recognize your model ID, tell it the model’s limits and capabilities with `model_info``modelInfo`. Each provider reports what the SDK knows about its model as `model.model_info``model.modelInfo`: the context window, the output limit, and capabilities such as prompt caching. The SDK looks up the model ID in the [shared model info](https://github.com/strands-agents/harness-sdk/blob/main/shared/model-info.json). For an ID it can’t map, such as an application inference profile ARN or a proxy alias, the lookup finds nothing. The SDK then falls back to defaults such as a 200,000-token context window. Your `model_info``modelInfo` wins over everything else:

(( tab "Python" ))
```python
from strands.models import BedrockModel, ModelCapabilities, ModelInfo, ModelLimits

model = BedrockModel(
    model_id="arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3",
    model_info=ModelInfo(
        limits=ModelLimits(context_window=1_000_000, max_output_tokens=64_000),
        capabilities=ModelCapabilities(prompt_caching="cache_points"),
    ),
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

const model = new BedrockModel({
  modelId:
    'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3',
  modelInfo: {
    limits: { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
    capabilities: { promptCaching: 'cachePoints' },
  },
})
```
(( /tab "TypeScript" ))

Fields you leave unset keep their looked-up values.

## Next Steps

### Explore Model Providers

-   **[Amazon Bedrock](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md)** - Wide model selection, enterprise features, and full Python and TypeScript support
-   **[OpenAI](/docs/user-guide/sdk/model-providers/openai/index.md)** - GPT models with streaming support
-   **[Google](/docs/user-guide/sdk/model-providers/google/index.md)** - Google’s Gemini models with tool calling support
-   **[Custom Providers](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md)** - Build your own model integration
-   **[Anthropic](/docs/user-guide/sdk/model-providers/anthropic/index.md)** - Direct Claude API access