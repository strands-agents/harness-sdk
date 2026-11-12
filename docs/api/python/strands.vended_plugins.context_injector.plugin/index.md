ContextInjector plugin for injecting just-in-time context into the model input.

This module provides the ContextInjector plugin, which writes just-in-time text into the latest user message before each model call, as an `injected` block that stays in the conversation.

**Example**:

```python
import datetime

from strands import Agent
from strands.vended_plugins.context_injector import ContextInjector

agent = Agent(
    plugins=[
        ContextInjector(lambda context: f"<now>\{datetime.datetime.now().isoformat()}</now>")
    ]
)
```

## ContextInjector

```python
class ContextInjector(Plugin)
```

Defined in: [src/strands/vended\_plugins/context\_injector/plugin.py:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/context_injector/plugin.py#L45)

Plugin that injects just-in-time context into the model input before each call.

Before each model call, the plugin asks `render_content` for text, gated by `trigger`, and writes it into the latest user message as an `injected` block. The block stays in the conversation and in snapshot sessions; the File and S3 session managers save each message once, when it is added, so they don’t keep it. When the model takes temporary messages (`AnthropicModel` on supported Claude models), the model receives each block as a system message it reads only until the next user message, so the stored history is sent unchanged on every call. Every other model receives only the latest user message’s blocks, as text.

Multiple injectors may be registered; each contributes its text independently, in plugin-registration order.

**Arguments**:

-   `render_content` - Renders the text to write into the latest user message, or `None`/`""` to skip. Sync or async. The text reaches the model verbatim, so it is a prompt-injection
-   `surface` - escape any attacker-influenced fields yourself. On a model that takes temporary messages it arrives as a system message, which the model ranks above the user, so never put content from outside the conversation (tool output, retrieved documents) in it. Called at most once per user message: a retry or a resume sends the text it returned the first time. A forced structured output call appends its own user message (unlike TS, which retries the same message), so the trigger fires again for it and a second block is written. A callback that raises fails open (injection is skipped, the model call proceeds).
-   `name` - Plugin name, for logging and duplicate detection. Defaults to `"strands:context-injector"`. The name is stored with every block the injector writes and keeps a retried call from writing again, including after a session restore, so keep it stable and give each injector its own.
-   `trigger` - When to inject. An `InjectionTrigger` name selects a built-in policy (`"userTurn"` — default — or `"everyTurn"`); a predicate over the `InjectionContext` is the escape hatch. A predicate that raises fails open (injection is skipped). Defaults to `"userTurn"`.

**Example**:

```python
from strands import Agent
from strands.vended_plugins.context_injector import ContextInjector

agent = Agent(
    plugins=[
        ContextInjector(lambda context: f"<context>\{derive(context.messages)}</context>")
    ]
)
```

#### \_\_init\_\_

```python
def __init__(render_content: RenderContent,
             *,
             name: str | None = None,
             trigger: InjectionTriggerPredicate | None = None) -> None
```

Defined in: [src/strands/vended\_plugins/context\_injector/plugin.py:94](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/context_injector/plugin.py#L94)

Initialize the ContextInjector plugin.

**Arguments**:

-   `render_content` - Renders the text to write into the latest user message. Sync or async.
-   `name` - Plugin name. Defaults to `"strands:context-injector"`.
-   `trigger` - When to inject. Defaults to `"userTurn"`.

#### init\_agent

```python
def init_agent(agent: Agent) -> None
```

Defined in: [src/strands/vended\_plugins/context\_injector/plugin.py:113](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/context_injector/plugin.py#L113)

Register the injection handler on the agent’s `InvokeModelStage` input phase.