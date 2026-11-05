"""Tests for the handoff_to_user tool."""

from types import SimpleNamespace

import pytest

from strands import Agent
from strands.interrupt import InterruptException, _InterruptState
from strands.types.tools import ToolContext
from strands.vended_tools.handoff_to_user import (
    HANDOFF_INTERRUPT_NAME,
    handoff_to_user,
    make_handoff_to_user,
)
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _tool_context(tool_use_id: str = "id", interrupt_state: _InterruptState | None = None) -> ToolContext:
    """Build a minimal ToolContext with a real ``_interrupt_state`` on the agent.

    ``_Interruptible.interrupt()`` looks up ``self.agent._interrupt_state``, so
    the mock agent must carry a real (or pre-populated) ``_InterruptState``.
    """
    state = interrupt_state if interrupt_state is not None else _InterruptState()
    agent = SimpleNamespace(_interrupt_state=state)
    return ToolContext(
        tool_use={"name": "handoff_to_user", "toolUseId": tool_use_id, "input": {}},
        agent=agent,
        invocation_state={},
    )


def _tool_use_msg(name: str, tool_use_id: str, tool_input: dict) -> dict:
    tool_use = {"toolUseId": tool_use_id, "name": name, "input": tool_input}
    return {"role": "assistant", "content": [{"toolUse": tool_use}]}


def _text_msg(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


class TestHandoffBehavior:
    """The tool raises InterruptException on first call and returns the response on resume."""

    @pytest.mark.asyncio
    async def test_first_call_raises_interrupt_with_message_and_name(self):
        ctx = _tool_context()
        with pytest.raises(InterruptException) as exc_info:
            await handoff_to_user(tool_context=ctx, message="please confirm")
        interrupt = exc_info.value.interrupt
        assert interrupt.reason == "please confirm"
        assert interrupt.name == HANDOFF_INTERRUPT_NAME


class TestInputValidation:
    """The tool validates the ``message`` argument before touching interrupt state."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("blank", ["", "   "])
    async def test_rejects_blank_message_without_registering_interrupt(self, blank):
        state = _InterruptState()
        ctx = _tool_context(interrupt_state=state)
        with pytest.raises(ValueError, match="must not be empty"):
            await handoff_to_user(tool_context=ctx, message=blank)
        # Validation runs before any interrupt side effect.
        assert state.interrupts == {}

    @pytest.mark.asyncio
    async def test_rejects_non_string_message_without_registering_interrupt(self):
        state = _InterruptState()
        ctx = _tool_context(interrupt_state=state)
        with pytest.raises(ValueError, match="must be a string, got int"):
            await handoff_to_user(tool_context=ctx, message=42)
        # Validation runs before any interrupt side effect.
        assert state.interrupts == {}


class TestToolMetadata:
    """Tool name, description, and input schema."""

    def test_default_tool_spec(self):
        assert handoff_to_user.tool_name == "handoff_to_user"
        schema = handoff_to_user.tool_spec["inputSchema"]["json"]
        assert "message" in schema["properties"]
        assert "tool_context" not in schema["properties"]
        assert "message" in schema.get("required", [])

    def test_factory_customizes_name_and_description(self):
        tru_tool = make_handoff_to_user(name="ask_user", description="my desc")
        assert tru_tool.tool_name == "ask_user"
        assert tru_tool.tool_spec["description"] == "my desc"


class TestHandoffToUserAgentLoop:
    """Full interrupt/resume lifecycle through the agent event loop."""

    def test_loop_halts_with_interrupt_and_message_as_reason(self):
        model = MockedModelProvider(
            [
                _tool_use_msg("handoff_to_user", "htu-1", {"message": "What is your address?"}),
                _text_msg("Thanks, got it."),
            ]
        )
        agent = Agent(model=model, tools=[handoff_to_user])

        result = agent("Process my order")

        assert result.stop_reason == "interrupt"
        assert result.interrupts is not None
        assert len(result.interrupts) == 1
        assert result.interrupts[0].name == HANDOFF_INTERRUPT_NAME
        assert result.interrupts[0].reason == "What is your address?"

    def test_resume_returns_reply_as_tool_result_and_model_continues(self):
        model = MockedModelProvider(
            [
                _tool_use_msg("handoff_to_user", "htu-2", {"message": "Confirm your email"}),
                _text_msg("All done."),
            ]
        )
        agent = Agent(model=model, tools=[handoff_to_user])

        result = agent("Verify me")
        assert result.stop_reason == "interrupt"

        interrupt_id = result.interrupts[0].id
        resumed = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "yes@example.com"}}])

        assert resumed.stop_reason == "end_turn"
        assert "All done" in str(resumed)
        # The human's reply is surfaced to the model as the handoff tool's result.
        tool_result = next(
            block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
        )
        assert tool_result["content"][0]["text"] == "yes@example.com"

    def test_interrupt_name_is_constant_even_when_tool_is_renamed(self):
        # The interrupt name is a stable discriminator: renaming the tool via the
        # factory must not change it, so consumers can match on HANDOFF_INTERRUPT_NAME.
        ask_user = make_handoff_to_user(name="ask_user")
        model = MockedModelProvider(
            [
                _tool_use_msg("ask_user", "htu-3", {"message": "Enter PIN"}),
                _text_msg("PIN accepted."),
            ]
        )
        agent = Agent(model=model, tools=[ask_user])

        result = agent("Authenticate")

        assert result.stop_reason == "interrupt"
        assert result.interrupts[0].name == HANDOFF_INTERRUPT_NAME
