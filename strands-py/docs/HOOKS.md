# Hooks System

The hooks system enables extensible agent functionality through strongly-typed event callbacks.

## Terminology

- **Paired events**: Events that denote the beginning and end of an operation
- **Hook callback**: A function that receives a strongly-typed event argument
- **Hook provider**: An object implementing `HookProvider` that registers callbacks via `register_hooks()`

## Naming Conventions

- All hook events have a suffix of `Event`
- Paired events follow `Before{Action}Event` and `After{Action}Event`
- Action words come after the lifecycle indicator (e.g., `BeforeToolCallEvent` not `BeforeToolEvent`)

## Paired Events

- For every `Before` event there is a corresponding `After` event during tool execution, even if an exception occurs
- If a `Before` event hook raises an exception or triggers an interrupt that short-circuits before execution begins, the corresponding `After` event does not fire
- `After` events invoke callbacks in reverse registration order (for proper cleanup)

## Writable Properties

Some events have writable properties that modify agent behavior. Values are re-read after callbacks complete. For example, `BeforeToolCallEvent.selected_tool` is writable - after invoking the callback, the modified `selected_tool` takes effect for the tool call.

## Available Events

### Model Streaming Events

#### `ModelStreamChunkEvent`

Fired for each raw streaming chunk received from the model during response generation. This event allows hook providers to observe streaming progress in real-time.

**Attributes:**
- `agent`: The agent instance that triggered this event
- `chunk`: The raw streaming chunk (`StreamEvent`) from the model response

**Use Cases:**
- Logging streaming progress
- Collecting metrics on streaming performance
- Content filtering during streaming
- Real-time monitoring of model output

**Example:**
```python
from strands.hooks import HookProvider, HookRegistry
from strands.hooks.events import ModelStreamChunkEvent

class StreamingLogger(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(ModelStreamChunkEvent, self.on_chunk)

    def on_chunk(self, event: ModelStreamChunkEvent) -> None:
        # Log each streaming chunk
        if "contentBlockDelta" in event.chunk:
            print(f"Received delta: {event.chunk}")

agent = Agent(hooks=[StreamingLogger()])
```
