"""Tests for the ContextInjector plugin."""

from typing import Any
from unittest.mock import MagicMock

import pytest

from strands.middleware.stages import InvokeModelContext, InvokeModelStage
from strands.vended_plugins.context_injector import ContextInjector


def user(text: str) -> dict:
    return {"role": "user", "content": [{"text": text}]}


def assistant(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


def make_agent() -> Any:
    """Build a mock agent that captures add_middleware registrations and exposes state."""
    agent = MagicMock()
    agent.state = MagicMock()
    return agent


def register(plugin: ContextInjector) -> tuple[Any, Any]:
    """Run the plugin's init_agent and return (agent, registered_handler)."""
    agent = make_agent()
    plugin.init_agent(agent)
    call = agent.add_middleware.call_args
    return agent, call


def invoke_ctx(messages: list[dict], agent: Any) -> InvokeModelContext:
    return InvokeModelContext(
        agent=agent,
        messages=messages,
        system_prompt=None,
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=MagicMock(),
    )


class TestPluginInterface:
    def test_defaults_to_strands_context_injector_name(self):
        assert ContextInjector(lambda context: "x").name == "strands:context-injector"

    def test_honors_a_custom_name(self):
        assert ContextInjector(lambda context: "x", name="now").name == "now"

    def test_registers_invoke_model_input_middleware_on_init_agent(self):
        _, call = register(ContextInjector(lambda context: "x"))

        assert call is not None
        stage_or_phase, handler = call.args
        assert stage_or_phase is InvokeModelStage.Input
        assert callable(handler)


@pytest.mark.asyncio
class TestRegisteredHandler:
    async def run(self, plugin, messages):
        agent, call = register(plugin)
        handler = call.args[1]
        return await handler(invoke_ctx(messages, agent))

    async def test_folds_render_content_text_into_latest_user_message(self):
        result = await self.run(
            ContextInjector(lambda context: "INJECTED"),
            [assistant("prior"), user("ask")],
        )
        assert result.messages == [
            {"role": "assistant", "content": [{"text": "prior"}]},
            {"role": "user", "content": [{"text": "ask"}, {"text": "\n\nINJECTED"}]},
        ]

    async def test_skips_on_non_user_turn_by_default(self):
        render = MagicMock(return_value="x")
        ctx = invoke_ctx([user("ask"), assistant("reply")], make_agent())

        agent, call = register(ContextInjector(render))
        result = await call.args[1](ctx)

        render.assert_not_called()
        assert result is ctx

    async def test_every_turn_injects_regardless_of_latest_role(self):
        result = await self.run(
            ContextInjector(lambda context: "INJECTED", trigger="everyTurn"),
            [user("ask"), assistant("reply")],
        )
        # No later user message than index 0, so the fold targets it.
        assert result.messages == [
            {"role": "user", "content": [{"text": "ask"}, {"text": "\n\nINJECTED"}]},
            {"role": "assistant", "content": [{"text": "reply"}]},
        ]

    async def test_exposes_state_and_agent_to_render_content(self):
        records: dict = {}

        def record(context):
            records["agent"] = context.agent
            records["state"] = context.state
            return None

        agent, call = register(ContextInjector(record))
        await call.args[1](invoke_ctx([user("ask")], agent))

        assert records["agent"] is agent
        assert records["state"] is agent.state

    async def test_fails_open_when_render_content_raises(self):
        def boom(context):
            raise ValueError("boom")

        result = await self.run(ContextInjector(boom), [assistant("prior"), user("ask")])
        # Unchanged: the original messages, no injected block.
        assert result.messages == [
            {"role": "assistant", "content": [{"text": "prior"}]},
            {"role": "user", "content": [{"text": "ask"}]},
        ]
