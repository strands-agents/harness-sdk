from strands import Agent
from strands.hooks import AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent
from strands.plugins import Plugin, hook


class TypedPlugin(Plugin):
    name = "typed-plugin"

    @hook
    def on_before_invocation(self, event: BeforeInvocationEvent) -> None:
        pass

    @hook()
    async def on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        pass


@hook
def on_after_invocation(event: AfterInvocationEvent) -> None:
    pass


async def call_hooks(
    plugin: TypedPlugin, invocation_event: BeforeInvocationEvent, model_event: BeforeModelCallEvent
) -> None:
    plugin.on_before_invocation(invocation_event)
    plugin.on_before_invocation(model_event)  # type: ignore[arg-type]
    await plugin.on_before_model_call(model_event)


def register_hooks() -> None:
    Agent(hooks=[on_after_invocation])
