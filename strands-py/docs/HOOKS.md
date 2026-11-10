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
