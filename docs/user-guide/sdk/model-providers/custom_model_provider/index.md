When Strands Agents doesn’t ship a provider for the model you want to run, implement the `Model` interface yourself. A custom model provider connects any LLM service to the agent loop while keeping the integration private to your codebase.

## Model Provider Architecture

To connect your model service to the agent loop, extend the abstract `Model` class. Your provider converts conversation messages, the system prompt, and tool specifications into requests for your model API. It converts the API’s responses into Strands Agents streaming events.

The agent loop consumes those events to assemble the response and run requested tools.

## Implementation Overview

The interface is the same in both SDKs:

(( tab "Python" ))
Extend the `Model` class from `strands.models` and implement its abstract methods:

-   `stream()`: Handle model invocation and yield streaming events. Implement it as an async generator that yields `StreamEvent` objects.
-   `update_config()`: Update the model configuration.
-   `get_config()`: Return the current model configuration.
-   `structured_output()`: Produce a schema-validated response, yielding model events with the last event holding the structured output.

The base class also provides optional methods you can override:

-   `count_tokens()`: Estimate input token count (defaults to a character-based heuristic).
-   `estimate_utilization()`: Compute the ratio of input tokens to `context_window_limit` (defaults to 200,000 when not configured). See [Utilization Estimation](/docs/user-guide/sdk/agents/conversation-management/index.md#utilization-estimation).
(( /tab "Python" ))

(( tab "TypeScript" ))
Extend the `Model` class from `@strands-agents/sdk` and implement its abstract methods:

-   `stream()`: Handle model invocation and yield streaming events. Implement it as an async generator that yields `ModelStreamEvent` objects.
-   `updateConfig()`: Update the model configuration.
-   `getConfig()`: Return the current model configuration.

The base class also provides optional methods you can override:

-   `countTokens()`: Estimate input token count (defaults to a character-based heuristic).
-   `estimateUtilization()`: Compute the ratio of input tokens to `contextWindowLimit` (defaults to 200,000 when not configured). See [Utilization Estimation](/docs/user-guide/sdk/agents/conversation-management/index.md#utilization-estimation).
(( /tab "TypeScript" ))

## Implementing a Custom Model Provider

### 1\. Create Your Model Class

Create a new module in your codebase that extends the Strands Agents `Model` class.

(( tab "Python" ))
Define a `ModelConfig` `TypedDict` to hold the settings for invoking your model.

your\_org/models/custom\_model.py

```python
import logging
import os
from typing import Any, AsyncIterable, Optional, TypedDict
from typing_extensions import Unpack, override

from custom.model import CustomModelClient

from strands.models import Model
from strands.types.content import Messages
from strands.types.streaming import StreamEvent
from strands.types.tools import ToolSpec

logger = logging.getLogger(__name__)


class CustomModel(Model):
    """Your custom model provider implementation."""

    class ModelConfig(TypedDict):
        """
        Configuration your model.

        Attributes:
            model_id: ID of Custom model.
            params: Model parameters (e.g., max_tokens).
        """
        model_id: str
        params: Optional[dict[str, Any]]
        # Add any additional configuration parameters specific to your model

    def __init__(
        self,
        api_key: str,
        *,
        **model_config: Unpack[ModelConfig]
    ) -> None:
        """Initialize provider instance.

        Args:
            api_key: The API key for connecting to your Custom model.
            **model_config: Configuration options for Custom model.
        """
        self.config = CustomModel.ModelConfig(**model_config)
        logger.debug("config=<%s> | initializing", self.config)

        self.client = CustomModelClient(api_key)

    @override
    def update_config(self, **model_config: Unpack[ModelConfig]) -> None:
        """Update the Custom model configuration with the provided arguments.

        Can be invoked by tools to dynamically alter the model state for subsequent invocations by the agent.

        Args:
            **model_config: Configuration overrides.
        """
        self.config.update(model_config)


    @override
    def get_config(self) -> ModelConfig:
        """Get the Custom model configuration.

        Returns:
            The Custom model configuration.
        """
        return self.config
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Create a TypeScript module that extends the `Model` class. Define an interface for your model configuration to ensure type safety.

src/models/custom-model.ts

```typescript
// Mock client for documentation purposes
interface CustomModelClient {
  streamCompletion: (request: any) => AsyncIterable<any>
}

/**
 * Configuration interface for the custom model.
 */
export interface CustomModelConfig extends BaseModelConfig {
  apiKey?: string
  modelId?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  // Add any additional configuration parameters specific to your model
}

/**
 * Custom model provider implementation.
 *
 * Note: In practice, you would extend the Model abstract class from the SDK.
 * This example shows the interface implementation for documentation purposes.
 */
export class CustomModel {
  private client: CustomModelClient
  private config: CustomModelConfig

  constructor(config: CustomModelConfig) {
    this.config = { ...config }
    // Initialize your custom model client
    this.client = {
      streamCompletion: async function* () {
        yield { type: 'message_start', role: 'assistant' }
      },
    }
  }

  updateConfig(config: Partial<CustomModelConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): CustomModelConfig {
    return { ...this.config }
  }

  async *stream(
    messages: Message[],
    options?: {
      systemPrompt?: string | string[]
      toolSpecs?: ToolSpec[]
      toolChoice?: any
    }
  ): AsyncIterable<ModelStreamEvent> {
    // Implementation in next section
    // This is a placeholder that yields nothing
    if (false) yield {} as ModelStreamEvent
  }
}
```
(( /tab "TypeScript" ))

### 2\. Implement the `stream` Method

`stream()` is the single entry point for every model interaction: it formats the request, invokes the model, and yields the response as it streams back.

(( tab "Python" ))
The `stream` method accepts three parameters:

-   [`Messages`](/docs/api/python/strands.types.content#Messages): A list of Strands Agents messages, containing a [Role](/docs/api/python/strands.types.content#Role) and a list of [ContentBlocks](/docs/api/python/strands.types.content#ContentBlock).
-   [`list[ToolSpec]`](/docs/api/python/strands.types.tools#ToolSpec): List of tool specifications that the model can decide to use.
-   `SystemPrompt`: A system prompt string given to the Model to prompt it how to answer the user.

```python
    @override
    async def stream(
        self,
        messages: Messages,
        tool_specs: Optional[list[ToolSpec]] = None,
        system_prompt: Optional[str] = None,
        **kwargs: Any
    ) -> AsyncIterable[StreamEvent]:
        """Stream responses from the Custom model.

        Args:
            messages: List of conversation messages
            tool_specs: Optional list of available tools
            system_prompt: Optional system prompt
            **kwargs: Additional keyword arguments for future extensibility

        Returns:
            Iterator of StreamEvent objects
        """
        logger.debug("messages=<%s> tool_specs=<%s> system_prompt=<%s> | formatting request",
                    messages, tool_specs, system_prompt)

        # Format the request for your model API
        request = {
            "messages": messages,
            "tools": tool_specs,
            "system_prompt": system_prompt,
            **self.config,  # Include model configuration
        }

        logger.debug("request=<%s> | invoking model", request)

        # Invoke your model
        try:
            response = await self.client(**request)
        except OverflowException as e:
            raise ContextWindowOverflowException() from e

        logger.debug("response received | processing stream")

        # Process and yield streaming events
        # If your model doesn't return a MessageStart event, create one
        yield {
            "messageStart": {
                "role": "assistant"
            }
        }

        # Process each chunk from your model's response
        async for chunk in response["stream"]:
            # Convert your model's event format to Strands Agents StreamEvent
            if chunk.get("type") == "text_delta":
                yield {
                    "contentBlockDelta": {
                        "delta": {
                            "text": chunk.get("text", "")
                        }
                    }
                }
            elif chunk.get("type") == "message_stop":
                yield {
                    "messageStop": {
                        "stopReason": "end_turn"
                    }
                }

        logger.debug("stream processing complete")
```

For more complex implementations, you may want to create helper methods to organize your code:

```python
    def _format_request(
        self,
        messages: Messages,
        tool_specs: Optional[list[ToolSpec]] = None,
        system_prompt: Optional[str] = None
    ) -> dict[str, Any]:
        """Optional helper method to format requests for your model API."""
        return {
            "messages": messages,
            "tools": tool_specs,
            "system_prompt": system_prompt,
            **self.config,
        }

    def _format_chunk(self, event: Any) -> Optional[StreamEvent]:
        """Optional helper method to format your model's response events."""
        if event.get("type") == "text_delta":
            return {
                "contentBlockDelta": {
                    "delta": {
                        "text": event.get("text", "")
                    }
                }
            }
        elif event.get("type") == "message_stop":
            return {
                "messageStop": {
                    "stopReason": "end_turn"
                }
            }
        return None
```

> Note: `stream` must be implemented async. If your client does not support async invocation, you may consider wrapping the relevant calls in a thread so as not to block the async event loop. For an example on how to achieve this, you can check out the [BedrockModel](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/bedrock.py) provider implementation.
(( /tab "Python" ))

(( tab "TypeScript" ))
The `stream` method is the core interface that handles model invocation and returns streaming events. This method must be implemented as an async generator.

```typescript
// Implementation of the stream method and helper methods

export class CustomModelStreamExample {
  private config: CustomModelConfig
  private client: CustomModelClient

  constructor(config: CustomModelConfig) {
    this.config = config
    this.client = {
      streamCompletion: async function* () {
        yield { type: 'message_start', role: 'assistant' }
      },
    }
  }

  updateConfig(config: Partial<CustomModelConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getConfig(): CustomModelConfig {
    return { ...this.config }
  }

  async *stream(
    messages: Message[],
    options?: {
      systemPrompt?: string | string[]
      toolSpecs?: ToolSpec[]
      toolChoice?: any
    }
  ): AsyncIterable<ModelStreamEvent> {
    // 1. Format messages for your model's API
    const formattedMessages = this.formatMessages(messages)
    const formattedTools = options?.toolSpecs
      ? this.formatTools(options.toolSpecs)
      : undefined

    // 2. Prepare the API request
    const request = {
      model: this.config.modelId,
      messages: formattedMessages,
      systemPrompt: options?.systemPrompt,
      tools: formattedTools,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
      stream: true,
    }

    // 3. Call your model's API and stream responses
    const response = await this.client.streamCompletion(request)

    // 4. Convert API events to Strands ModelStreamEvent format
    for await (const chunk of response) {
      yield this.convertToModelStreamEvent(chunk)
    }
  }

  private formatMessages(messages: Message[]): any[] {
    return messages.map((message) => ({
      role: message.role,
      content: this.formatContent(message.content),
    }))
  }

  private formatContent(content: ContentBlock[]): any {
    // Convert Strands content blocks to your model's format
    return content.map((block) => {
      if (block.type === 'textBlock') {
        return { type: 'text', text: block.text }
      }
      // Handle other content types...
      return block
    })
  }

  private formatTools(toolSpecs: ToolSpec[]): any[] {
    return toolSpecs.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }))
  }

  private convertToModelStreamEvent(chunk: any): ModelStreamEvent {
    // Convert your model's streaming response to ModelStreamEvent

    if (chunk.type === 'message_start') {
      const event: ModelMessageStartEventData = {
        type: 'modelMessageStartEvent',
        role: chunk.role,
      }
      return event
    }

    if (chunk.type === 'content_block_delta') {
      if (chunk.delta.type === 'text_delta') {
        const event: ModelContentBlockDeltaEventData = {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'textDelta',
            text: chunk.delta.text,
          },
        }
        return event
      }
    }

    if (chunk.type === 'message_stop') {
      const event: ModelMessageStopEventData = {
        type: 'modelMessageStopEvent',
        stopReason: this.mapStopReason(chunk.stopReason),
      }
      return event
    }

    throw new Error(`Unsupported chunk type: ${chunk.type}`)
  }

  private mapStopReason(
    reason: string
  ): 'endTurn' | 'maxTokens' | 'toolUse' | 'stopSequence' {
    const stopReasonMap: Record<
      string,
      'endTurn' | 'maxTokens' | 'toolUse' | 'stopSequence'
    > = {
      end_turn: 'endTurn',
      max_tokens: 'maxTokens',
      tool_use: 'toolUse',
      stop_sequence: 'stopSequence',
    }
    return stopReasonMap[reason] || 'endTurn'
  }
}
```
(( /tab "TypeScript" ))

### 3\. Understanding StreamEvent Types

Your custom model provider needs to convert your model’s response events to Strands Agents streaming event format.

(( tab "Python" ))
Events use the dictionary-based [StreamEvent](/docs/api/python/strands.types.streaming#StreamEvent) format:

-   [`messageStart`](/docs/api/python/strands.types.streaming#MessageStartEvent): Event signaling the start of a message in a streaming response. This should have the `role`: `assistant`

```python
{
    "messageStart": {
        "role": "assistant"
    }
}
```

-   [`contentBlockStart`](/docs/api/python/strands.types.streaming#ContentBlockStartEvent): Event signaling the start of a content block. If this is the first event of a tool use request, then set the `toolUse` key to have the value [ContentBlockStartToolUse](/docs/api/python/strands.types.content#ContentBlockStartToolUse)

```python
{
    "contentBlockStart": {
        "start": {
            "name": "someToolName", # Only include name and toolUseId if this is the start of a ToolUseContentBlock
            "toolUseId": "uniqueToolUseId"
        }
    }
}
```

-   [`contentBlockDelta`](/docs/api/python/strands.types.streaming#ContentBlockDeltaEvent): Event continuing a content block. This event can be sent several times, and each piece of content will be appended to the previously sent content.

```python
{
    "contentBlockDelta": {
        "delta": { # Only include one of the following keys in each event
            "text": "Some text", # String response from a model
            "reasoningContent": { # Dictionary representing the reasoning of a model.
                "redactedContent": b"Some encrypted bytes",
                "signature": "verification token",
                "text": "Some reasoning text"
            },
            "toolUse": { # Dictionary representing a toolUse request. This is a partial json string.
                "input": "Partial json serialized response"
            }
        }
    }
}
```

-   [`contentBlockStop`](/docs/api/python/strands.types.streaming#ContentBlockStopEvent): Event marking the end of a content block. Once this event is sent, all previous events between the previous [ContentBlockStartEvent](/docs/api/python/strands.types.streaming#ContentBlockStartEvent) and this one can be combined to create a [ContentBlock](/docs/api/python/strands.types.content#ContentBlock)

```python
{
    "contentBlockStop": {}
}
```

-   [`messageStop`](/docs/api/python/strands.types.streaming#MessageStopEvent): Event marking the end of a streamed response, and the [StopReason](/docs/api/python/strands.types.event_loop#StopReason). No more content block events are expected after this event is returned.

```python
{
    "messageStop": {
        "stopReason": "end_turn"
    }
}
```

-   [`metadata`](/docs/api/python/strands.types.streaming#MetadataEvent): Event representing the metadata of the response. This contains the input, output, and total token count, along with the latency of the request.

```python
{
    "metrics": {
        "latencyMs": 123 # Latency of the model request in milliseconds.
    },
    "usage": {
        "inputTokens": 234, # Number of tokens sent in the request to the model.
        "outputTokens": 234, # Number of tokens that the model generated for the request.
        "totalTokens": 468 # Total number of tokens (input + output).
    }
}
```

-   [`redactContent`](/docs/api/python/strands.types.streaming#RedactContentEvent): Event that is used to redact the users input message, or the generated response of a model. This is useful for redacting content if a guardrail gets triggered.

```python
{
    "redactContent": {
        "redactUserContentMessage": "User input Redacted",
        "redactAssistantContentMessage": "Assistant output Redacted"
    }
}
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Events use the `ModelStreamEvent` data interface types. Create events as plain objects matching these interfaces:

-   `ModelMessageStartEvent`: Signals the start of a message response

```typescript
const messageStart: ModelMessageStartEventData = {
  type: 'modelMessageStartEvent',
  role: 'assistant',
}
```

-   `ModelContentBlockStartEvent`: Signals the start of a content block

```typescript
// For text blocks
const textBlockStart: ModelContentBlockStartEventData = {
  type: 'modelContentBlockStartEvent',
}

// For tool use blocks
const toolUseStart: ModelContentBlockStartEventData = {
  type: 'modelContentBlockStartEvent',
  start: {
    type: 'toolUseStart',
    toolUseId: 'tool_123',
    name: 'calculator',
  },
}
```

-   `ModelContentBlockDeltaEvent`: Provides incremental content

```typescript
// For text
const textDelta: ModelContentBlockDeltaEventData = {
  type: 'modelContentBlockDeltaEvent',
  delta: { type: 'textDelta', text: 'Hello' },
}

// For tool input
const toolInputDelta: ModelContentBlockDeltaEventData = {
  type: 'modelContentBlockDeltaEvent',
  delta: { type: 'toolUseInputDelta', input: '{"x": 1' },
}

// For reasoning content
const reasoningDelta: ModelContentBlockDeltaEventData = {
  type: 'modelContentBlockDeltaEvent',
  delta: {
    type: 'reasoningContentDelta',
    text: 'thinking...',
    signature: 'sig',
    redactedContent: new Uint8Array([]),
  },
}
```

-   `ModelContentBlockStopEvent`: Signals the end of a content block

```typescript
const blockStop: ModelStreamEvent = {
  type: 'modelContentBlockStopEvent',
}
```

-   `ModelMessageStopEvent`: Signals the end of the message with stop reason

```typescript
const messageStop: ModelMessageStopEventData = {
  type: 'modelMessageStopEvent',
  stopReason: 'endTurn', // Or 'maxTokens', 'toolUse', 'stopSequence'
}
```

-   `ModelMetadataEvent`: Provides usage and metrics information

```typescript
const metadata: ModelMetadataEventData = {
  type: 'modelMetadataEvent',
  usage: {
    inputTokens: 234,
    outputTokens: 234,
    totalTokens: 468,
  },
  metrics: {
    latencyMs: 123,
  },
}
```
(( /tab "TypeScript" ))

### 4\. Use Your Custom Model Provider

Once implemented, you can use your custom model provider in your applications for regular agent invocation:

(( tab "Python" ))
```python
from strands import Agent
from your_org.models.custom_model import CustomModel

# Initialize your custom model provider
custom_model = CustomModel(
    api_key="your-api-key",
    model_id="your-model-id",
    params={
        "max_tokens": 2000,
        "temperature": 0.7,
    },
)

# Create a Strands agent using your model
agent = Agent(model=custom_model)

# Use the agent as usual
response = agent("Hello, how are you today?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
async function usageExample() {
  // Initialize your custom model provider
  const customModel = new YourCustomModel({
    maxTokens: 2000,
    temperature: 0.7,
  })

  // Create a Strands agent using your model
  const agent = new Agent({ model: customModel })

  // Use the agent as usual
  const response = await agent.invoke('Hello, how are you today?')
}
```
(( /tab "TypeScript" ))

## Key Implementation Considerations

### Message Formatting

Strands Agents uses a structured message format with `role` and `content` fields; your model API likely expects a different shape. Convert Strands Agents’ `Messages`, `ToolSpec`, and `SystemPrompt` types to your API’s format on the way in, and convert the API’s streaming response back into `StreamEvent`s on the way out. Both conversions belong in `stream()`.

### Tool Support

If your model API supports tool calling, format the tool specifications in `stream()`, emit the tool-use stream events during response processing, and format tool calls and results in your message conversion.

### Error Handling

Map your API’s failures onto the SDK’s exceptions so the agent loop can react. Handle context window overflows (raise `ContextWindowOverflowException`), connection errors, authentication failures, rate limits, and malformed responses.

## Related pages

- [Tools](/docs/user-guide/sdk/bidi/tools/index.md) (1 shared tag)
- [Middleware](/docs/user-guide/sdk/agents/middleware/index.md) (1 shared tag)
- [Tool Executors](/docs/user-guide/sdk/tools/executors/index.md) (1 shared tag)
- [Available Sandboxes](/docs/user-guide/sdk/sandbox/available-sandboxes/index.md) (1 shared tag)
- [Building a Custom Sandbox](/docs/user-guide/sdk/sandbox/custom-sandbox/index.md) (1 shared tag)
- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (1 shared tag)
- [Sandbox](/docs/user-guide/sdk/sandbox/index.md) (1 shared tag)
- [Agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) (1 shared tag)
- [Hook events](/docs/user-guide/sdk/agents/hooks-events/index.md) (1 shared tag)
- [Hooks](/docs/user-guide/sdk/agents/hooks/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/models/model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py)

### TypeScript

- [harness-sdk/strands-ts/src/models/model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts)
