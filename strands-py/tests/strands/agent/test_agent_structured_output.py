"""Tests for Agent structured output functionality."""

from unittest import mock
from unittest.mock import Mock, patch

import pytest
from pydantic import BaseModel

from strands import Agent, tool
from strands.hooks import AfterInvocationEvent, AfterToolsEvent, BeforeToolCallEvent, BeforeToolsEvent
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.structured_output._structured_output_context import (
    DEFAULT_STRUCTURED_OUTPUT_PROMPT,
    StructuredOutputContext,
)
from strands.tools.structured_output.structured_output_tool import StructuredOutputTool
from strands.types._events import EventLoopStopEvent
from strands.types.exceptions import StructuredOutputException
from tests.fixtures.mocked_model_provider import MockedModelProvider


class UserModel(BaseModel):
    """Test user model for structured output."""

    name: str
    age: int
    email: str


class ProductModel(BaseModel):
    """Test product model for structured output."""

    title: str
    price: float
    description: str | None = None


@pytest.fixture
def mock_model():
    """Create a mock model."""
    model = Mock()

    async def mock_stream(*args, **kwargs):
        yield {"contentBlockDelta": {"delta": {"text": "test response"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}

    model.stream.side_effect = lambda *args, **kwargs: mock_stream(*args, **kwargs)
    return model


@pytest.fixture
def mock_metrics():
    return mock.Mock(spec=EventLoopMetrics)


@pytest.fixture
def user_model():
    """Return the test user model class."""
    return UserModel


@pytest.fixture
def product_model():
    """Return the test product model class."""
    return ProductModel


class TestAgentStructuredOutputInit:
    """Test Agent initialization with structured output model."""

    def test_agent_init_with_structured_output_model(self, user_model):
        """Test that Agent can be initialized with a structured_output_model."""
        agent = Agent(structured_output_model=user_model)

        assert agent._default_structured_output_model == user_model
        assert agent.model is not None

    def test_agent_init_without_structured_output_model(self):
        """Test that Agent can be initialized without structured_output_model."""
        agent = Agent()

        assert agent._default_structured_output_model is None
        assert agent.model is not None


class TestAgentStructuredOutputInvocation:
    """Test Agent invocation with structured output."""

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_call_with_structured_output_model(self, mock_event_loop, user_model, mock_model, mock_metrics):
        """Test Agent.__call__ with structured_output_model parameter."""

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context is not None
            assert structured_output_context.structured_output_model == user_model

            # Return a successful result
            test_user = UserModel(name="John", age=30, email="john@example.com")
            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
                structured_output=test_user,
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent and call with structured_output_model
        agent = Agent(model=mock_model)
        agent("Extract user info", structured_output_model=user_model)

        # Verify event_loop_cycle was called with correct context
        mock_event_loop.assert_called_once()
        call_kwargs = mock_event_loop.call_args[1]
        assert "structured_output_context" in call_kwargs

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_call_with_default_structured_output_model(
        self, mock_event_loop, product_model, mock_model, mock_metrics
    ):
        """Test Agent.__call__ uses default structured_output_model when not specified."""

        # Setup mock event loop
        pm = ProductModel(title="Widget", price=9.99)

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context is not None
            assert structured_output_context.structured_output_model == product_model

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
                structured_output=pm,
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent with default structured_output_model
        agent = Agent(model=mock_model, structured_output_model=product_model)
        result = agent("Get product info")

        # Verify result uses default model
        assert result.structured_output is pm

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_call_override_default_structured_output_model(
        self, mock_event_loop, user_model, product_model, mock_model, mock_metrics
    ):
        """Test that invocation-level structured_output_model overrides default."""

        # Setup mock event loop
        um = UserModel(name="Jane", age=25, email="jane@example.com")

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            # Should use user_model, not the default product_model
            assert structured_output_context.structured_output_model == user_model

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
                structured_output=um,
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent with default product_model, but override with user_model
        agent = Agent(model=mock_model, structured_output_model=product_model)
        result = agent("Get user info", structured_output_model=user_model)

        # Verify result uses override model
        assert result.structured_output is um

    @pytest.mark.asyncio
    @patch("strands.agent.agent.event_loop_cycle")
    async def test_agent_invoke_async_with_structured_output(
        self, mock_event_loop, user_model, mock_model, mock_metrics
    ):
        """Test Agent.invoke_async with structured_output_model."""

        # Setup mock event loop
        um = UserModel(name="Alice", age=28, email="alice@example.com")

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context is not None
            assert structured_output_context.structured_output_model == user_model

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
                structured_output=um,
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent and call async
        agent = Agent(model=mock_model)
        result = await agent.invoke_async("Get user", structured_output_model=user_model)

        # Verify result
        assert result.structured_output is um

    @pytest.mark.asyncio
    @patch("strands.agent.agent.event_loop_cycle")
    async def test_agent_stream_async_with_structured_output(
        self, mock_event_loop, product_model, mock_model, mock_metrics
    ):
        """Test Agent.stream_async with structured_output_model."""

        # Setup mock event loop
        pm = ProductModel(title="Gadget", price=19.99, description="Cool gadget")

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context is not None
            assert structured_output_context.structured_output_model == product_model

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
                structured_output=pm,
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent and stream async
        agent = Agent(model=mock_model)
        events = []
        async for event in agent.stream_async("Get product", structured_output_model=product_model):
            events.append(event)

        # Verify we got result event
        assert len(events) > 0
        result_event = events[-1]
        assert "result" in result_event
        result = result_event["result"]
        assert result.structured_output is pm


class TestAgentStructuredOutputContext:
    """Test StructuredOutputContext integration with Agent."""

    @patch("strands.agent.agent.event_loop_cycle")
    def test_structured_output_context_created_with_model(self, mock_event_loop, user_model, mock_model, mock_metrics):
        """Test that StructuredOutputContext is created when structured_output_model is provided."""
        context = None

        async def mock_cycle(*args, **kwargs):
            nonlocal context
            context = kwargs.get("structured_output_context")
            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        agent = Agent(model=mock_model)
        agent("Test", structured_output_model=user_model)

        # Verify context was created and passed
        assert context is not None
        assert isinstance(context, StructuredOutputContext)
        assert context.structured_output_model == user_model
        assert context.is_enabled is True

    @patch("strands.agent.agent.event_loop_cycle")
    def test_structured_output_context_none_without_model(self, mock_event_loop, mock_model, mock_metrics):
        """Test that StructuredOutputContext is created with None when no model provided."""
        context = None

        async def mock_cycle(*args, **kwargs):
            nonlocal context
            context = kwargs.get("structured_output_context")
            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        agent = Agent(model=mock_model)
        agent("Test")  # No structured_output_model

        # Verify context was created but disabled
        assert context is not None
        assert isinstance(context, StructuredOutputContext)
        assert context.structured_output_model is None
        assert context.is_enabled is False

    @patch("strands.tools.registry.ToolRegistry.register_dynamic_tool")
    @patch("strands.agent.agent.event_loop_cycle")
    def test_structured_output_tool_registered_dynamically(
        self, mock_event_loop, mock_register, user_model, mock_model, mock_metrics
    ):
        """Test that StructuredOutputTool is registered dynamically when structured output is used."""
        captured_tool = None

        def capture_tool(tool):
            nonlocal captured_tool
            captured_tool = tool

        mock_register.side_effect = capture_tool

        async def mock_cycle(*args, **kwargs):
            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        agent = Agent(model=mock_model)
        agent("Test", structured_output_model=user_model)

        # Verify tool was registered
        mock_register.assert_called_once()
        assert captured_tool is not None
        assert isinstance(captured_tool, StructuredOutputTool)
        assert captured_tool.structured_output_model == user_model


class TestAgentStructuredOutputEdgeCases:
    """Test edge cases for structured output in Agent."""

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_with_no_structured_output(self, mock_event_loop, mock_model, mock_metrics):
        """Test that agent works normally when no structured output is specified."""

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context is not None
            assert structured_output_context.structured_output_model is None
            assert structured_output_context.is_enabled is False

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Normal response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        agent = Agent(model=mock_model)
        result = agent("Normal query")

        # Result should not have structured output
        assert result.structured_output is None
        assert result.message["content"][0]["text"] == "Normal response"

    def test_agent_multiple_structured_output_models(self, user_model, product_model, mock_metrics):
        """Test that agent can switch between different structured output models."""
        model = MockedModelProvider(
            [
                {"role": "assistant", "content": [{"text": "User response"}]},
                {"role": "assistant", "content": [{"text": "Product response"}]},
            ]
        )

        agent = Agent(model=model)

        # First call with user model
        with patch("strands.agent.agent.event_loop_cycle") as mock_event_loop:
            um = UserModel(name="Bob", age=40, email="bob@example.com")

            async def mock_user_cycle(*args, **kwargs):
                ctx = kwargs.get("structured_output_context")
                assert ctx.structured_output_model == user_model
                yield EventLoopStopEvent(
                    stop_reason="end_turn",
                    message={"role": "assistant", "content": [{"text": "User response"}]},
                    metrics=mock_metrics,
                    request_state={},
                    structured_output=um,
                )

            mock_event_loop.side_effect = mock_user_cycle
            result1 = agent("Get user", structured_output_model=user_model)
            assert result1.structured_output is um

        # Second call with product model
        with patch("strands.agent.agent.event_loop_cycle") as mock_event_loop:
            pm = ProductModel(title="Item", price=5.99)

            async def mock_product_cycle(*args, **kwargs):
                ctx = kwargs.get("structured_output_context")
                assert ctx.structured_output_model == product_model
                yield EventLoopStopEvent(
                    stop_reason="end_turn",
                    message={"role": "assistant", "content": [{"text": "Product response"}]},
                    metrics=mock_metrics,
                    request_state={},
                    structured_output=pm,
                )

            mock_event_loop.side_effect = mock_product_cycle
            result2 = agent("Get product", structured_output_model=product_model)
            assert result2.structured_output is pm


class TestAgentStructuredOutputPrompt:
    """Test Agent structured_output_prompt functionality."""

    def test_agent_init_with_structured_output_prompt(self, user_model):
        """Test that Agent can be initialized with a structured_output_prompt."""
        custom_prompt = "Please format your response using the schema."
        agent = Agent(structured_output_model=user_model, structured_output_prompt=custom_prompt)

        assert agent._structured_output_prompt == custom_prompt

    def test_agent_init_without_structured_output_prompt(self):
        """Test that Agent can be initialized without structured_output_prompt."""
        agent = Agent()

        assert agent._structured_output_prompt is None

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_call_with_default_structured_output_prompt(
        self, mock_event_loop, user_model, mock_model, mock_metrics
    ):
        """Test Agent.__call__ uses default structured_output_prompt when not specified."""
        custom_prompt = "Use the output schema to format your response."

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context is not None
            assert structured_output_context.structured_output_prompt == custom_prompt

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent with default structured_output_prompt
        agent = Agent(
            model=mock_model,
            structured_output_model=user_model,
            structured_output_prompt=custom_prompt,
        )
        agent("Get user info")

        mock_event_loop.assert_called_once()

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_call_override_default_structured_output_prompt(
        self, mock_event_loop, user_model, mock_model, mock_metrics
    ):
        """Test that invocation-level structured_output_prompt overrides default."""
        default_prompt = "Default prompt for structured output."
        override_prompt = "Override prompt for this specific call."

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            # Should use override_prompt, not the default
            assert structured_output_context.structured_output_prompt == override_prompt

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent with default prompt, but override at call time
        agent = Agent(
            model=mock_model,
            structured_output_model=user_model,
            structured_output_prompt=default_prompt,
        )
        agent("Get user info", structured_output_prompt=override_prompt)

        mock_event_loop.assert_called_once()

    @patch("strands.agent.agent.event_loop_cycle")
    def test_agent_call_with_invocation_prompt_no_default(self, mock_event_loop, user_model, mock_model, mock_metrics):
        """Test that invocation-level prompt works when no default is set."""
        invocation_prompt = "Format as structured output now."

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context.structured_output_prompt == invocation_prompt

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        # Create agent without default prompt
        agent = Agent(model=mock_model, structured_output_model=user_model)
        agent("Get user info", structured_output_prompt=invocation_prompt)

        mock_event_loop.assert_called_once()

    @pytest.mark.asyncio
    @patch("strands.agent.agent.event_loop_cycle")
    async def test_agent_invoke_async_with_structured_output_prompt(
        self, mock_event_loop, user_model, mock_model, mock_metrics
    ):
        """Test Agent.invoke_async with structured_output_prompt."""
        custom_prompt = "Async prompt for structured output."

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context.structured_output_prompt == custom_prompt

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        agent = Agent(model=mock_model, structured_output_model=user_model)
        await agent.invoke_async("Get user", structured_output_prompt=custom_prompt)

        mock_event_loop.assert_called_once()

    @pytest.mark.asyncio
    @patch("strands.agent.agent.event_loop_cycle")
    async def test_agent_stream_async_with_structured_output_prompt(
        self, mock_event_loop, user_model, mock_model, mock_metrics
    ):
        """Test Agent.stream_async with structured_output_prompt."""
        custom_prompt = "Stream async prompt for structured output."

        async def mock_cycle(*args, **kwargs):
            structured_output_context = kwargs.get("structured_output_context")
            assert structured_output_context.structured_output_prompt == custom_prompt

            yield EventLoopStopEvent(
                stop_reason="end_turn",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics=mock_metrics,
                request_state={},
            )

        mock_event_loop.side_effect = mock_cycle

        agent = Agent(model=mock_model, structured_output_model=user_model)
        async for _ in agent.stream_async("Get user", structured_output_prompt=custom_prompt):
            pass

        mock_event_loop.assert_called_once()


VALID_USER = {"name": "Alice", "age": 30, "email": "alice@example.com"}
TEXT_RESPONSE = {"role": "assistant", "content": [{"text": "Plain text instead of structured output"}]}


def _structured_output_response(tool_input, tool_use_id):
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": UserModel.__name__, "input": tool_input}}],
    }


class TestAgentStructuredOutputAttemptLimit:
    """Tests for the structured_output_attempts limit."""

    @pytest.mark.parametrize(
        ("responses", "exp_stop_reason"),
        [
            pytest.param(
                ["text", "text", "text", "text"], "limit_structured_output_attempts", id="no-output-tool-calls"
            ),
            pytest.param(
                ["invalid", "text", "text", "text"],
                "limit_structured_output_attempts",
                id="invalid-input-before-forcing",
            ),
            pytest.param(
                ["text", "other", "invalid", "text"],
                "limit_structured_output_attempts",
                id="different-tool-called-when-forced",
            ),
            pytest.param(["text", "text", "invalid", "valid"], "tool_use", id="valid-output-on-final-attempt"),
        ],
    )
    @pytest.mark.asyncio
    async def test_invoke_async_retries_failed_attempts_until_the_limit(self, responses, exp_stop_reason):
        messages = {
            "text": TEXT_RESPONSE,
            "invalid": _structured_output_response({}, "invalid"),
            "valid": _structured_output_response(VALID_USER, "valid"),
            "other": {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "other", "name": "unknown_tool", "input": {}}}],
            },
        }
        model = MockedModelProvider([messages[response] for response in responses] + [messages["valid"]])
        agent = Agent(model=model, callback_handler=None)

        result = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 3}
        )

        assert result.stop_reason == exp_stop_reason
        assert result.structured_output == (UserModel(**VALID_USER) if exp_stop_reason == "tool_use" else None)
        assert result.message["content"] == messages[responses[-1]]["content"]
        assert model.index == 4

    @pytest.mark.asyncio
    async def test_invoke_async_returns_model_reply_when_limit_is_reached_on_forced_retry(self):
        model = MockedModelProvider([TEXT_RESPONSE, TEXT_RESPONSE])
        agent = Agent(model=model, callback_handler=None)

        result = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 1}
        )

        assert result.stop_reason == "limit_structured_output_attempts"
        assert result.message == agent.messages[-1]
        assert agent.messages[-1]["content"] == TEXT_RESPONSE["content"]
        assert [message["content"] for message in agent.messages].count(
            [{"text": DEFAULT_STRUCTURED_OUTPUT_PROMPT}]
        ) == 1
        assert model.index == 2

    @pytest.mark.asyncio
    async def test_invoke_async_returns_model_reply_when_turn_limit_is_reached_before_forcing(self):
        model = MockedModelProvider([TEXT_RESPONSE])
        agent = Agent(model=model, callback_handler=None)

        result = await agent.invoke_async("Extract the data", structured_output_model=UserModel, limits={"turns": 1})

        assert result.stop_reason == "limit_turns"
        assert result.message == agent.messages[-1]
        assert agent.messages[-1]["content"] == TEXT_RESPONSE["content"]
        assert model.index == 1

    @pytest.mark.asyncio
    async def test_invoke_async_raises_without_attempt_limit_when_forced_retry_fails(self):
        model = MockedModelProvider([TEXT_RESPONSE, TEXT_RESPONSE])
        agent = Agent(model=model, callback_handler=None)

        with pytest.raises(StructuredOutputException, match="did not produce structured output"):
            await agent.invoke_async("Extract the data", structured_output_model=UserModel, limits={"turns": 5})

        assert model.index == 2

    @pytest.mark.asyncio
    async def test_invoke_async_starts_each_root_call_with_a_fresh_attempt_budget(self):
        model = MockedModelProvider([_structured_output_response({}, f"output-{attempt}") for attempt in range(6)])
        agent = Agent(model=model, callback_handler=None)

        for exp_calls in (3, 6):
            result = await agent.invoke_async(
                "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 3}
            )

            assert result.stop_reason == "limit_structured_output_attempts"
            assert result.structured_output is None
            assert model.index == exp_calls
            assert agent.messages[-1]["content"][0]["toolResult"]["status"] == "error"
            assert UserModel.__name__ not in agent.tool_registry.dynamic_tools

    @pytest.mark.asyncio
    async def test_invoke_async_continues_attempt_budget_when_passed_previous_invocation_context(self):
        model = MockedModelProvider([_structured_output_response({}, f"output-{attempt}") for attempt in range(3)])
        agent = Agent(model=model, callback_handler=None)
        first = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 2}
        )

        second = await agent.invoke_async(
            "Try again", structured_output_model=UserModel, invocation_context=first.invocation_context
        )

        assert (first.stop_reason, second.stop_reason) == (
            "limit_structured_output_attempts",
            "limit_structured_output_attempts",
        )
        assert model.index == 2

    @pytest.mark.asyncio
    async def test_invoke_async_preserves_attempt_budget_across_hook_resume(self):
        model = MockedModelProvider([_structured_output_response({}, f"output-{attempt}") for attempt in range(6)])
        agent = Agent(model=model, callback_handler=None)

        def interrupt_third_attempt(event: BeforeToolsEvent):
            if model.index == 3:
                event.interrupt("approve")

        def resume_interrupt(event: AfterInvocationEvent):
            if event.result and event.result.stop_reason == "interrupt":
                event.resume = [
                    {"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}
                    for interrupt in event.result.interrupts
                ]

        agent.hooks.add_callback(BeforeToolsEvent, interrupt_third_attempt)
        agent.hooks.add_callback(AfterInvocationEvent, resume_interrupt)

        result = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 3}
        )

        assert result.stop_reason == "limit_structured_output_attempts"
        assert result.structured_output is None
        assert model.index == 3

    @pytest.mark.asyncio
    async def test_invoke_async_counts_failed_attempt_on_cycle_that_pauses_at_checkpoint(self):
        model = MockedModelProvider([_structured_output_response({}, "invalid")])
        agent = Agent(model=model, checkpointing=True, callback_handler=None)
        after_model = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 1}
        )
        after_tools = await agent.invoke_async(
            {"checkpointResume": {"checkpoint": after_model.checkpoint.to_dict()}},
            structured_output_model=UserModel,
            invocation_context=after_model.invocation_context,
        )

        result = await agent.invoke_async(
            {"checkpointResume": {"checkpoint": after_tools.checkpoint.to_dict()}},
            structured_output_model=UserModel,
            invocation_context=after_tools.invocation_context,
        )

        assert (after_model.stop_reason, after_tools.stop_reason) == ("checkpoint", "checkpoint")
        assert result.stop_reason == "limit_structured_output_attempts"
        assert model.index == 1

    @pytest.mark.asyncio
    async def test_invoke_async_counts_forced_response_calling_another_tool_before_an_interrupt(self):
        @tool
        def lookup() -> str:
            """Look up a record."""
            return "found"

        model = MockedModelProvider(
            [
                TEXT_RESPONSE,
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "lookup", "name": "lookup", "input": {}}}]},
                _structured_output_response(VALID_USER, "valid"),
            ]
        )
        agent = Agent(model=model, tools=[lookup], callback_handler=None)
        agent.hooks.add_callback(BeforeToolsEvent, lambda event: event.interrupt("approve"))
        paused = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 1}
        )

        result = await agent.invoke_async(
            [
                {"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}
                for interrupt in paused.interrupts
            ],
            structured_output_model=UserModel,
            invocation_context=paused.invocation_context,
        )

        assert (paused.stop_reason, result.stop_reason) == ("interrupt", "limit_structured_output_attempts")
        assert model.index == 2

    @pytest.mark.asyncio
    async def test_invoke_async_does_not_count_valid_output_completed_before_an_interrupt(self):
        @tool
        def send_email() -> str:
            """Send an email."""
            return "sent"

        def approve_email(event: BeforeToolCallEvent):
            if event.tool_use["name"] == send_email.tool_name:
                event.interrupt("approve")

        model = MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [
                        {"toolUse": {"toolUseId": "email", "name": send_email.tool_name, "input": {}}},
                        *_structured_output_response(VALID_USER, "valid")["content"],
                    ],
                },
                TEXT_RESPONSE,
                _structured_output_response(VALID_USER, "again"),
            ]
        )
        agent = Agent(model=model, tools=[send_email], callback_handler=None)
        agent.hooks.add_callback(BeforeToolCallEvent, approve_email)
        paused = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 1}
        )

        result = await agent.invoke_async(
            [
                {"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}
                for interrupt in paused.interrupts
            ],
            structured_output_model=UserModel,
            invocation_context=paused.invocation_context,
        )

        assert result.stop_reason == "tool_use"
        assert result.structured_output == UserModel(**VALID_USER)

    @pytest.mark.asyncio
    async def test_invoke_async_counts_failed_attempt_when_hook_ends_the_turn(self):
        model = MockedModelProvider(
            [_structured_output_response({}, "invalid"), _structured_output_response({}, "again")]
        )
        agent = Agent(model=model, callback_handler=None)
        agent.hooks.add_callback(AfterToolsEvent, lambda event: setattr(event, "end_turn", "Paused for review"))
        ended = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 1}
        )

        result = await agent.invoke_async(
            "Continue", structured_output_model=UserModel, invocation_context=ended.invocation_context
        )

        assert (ended.stop_reason, result.stop_reason) == ("end_turn", "limit_structured_output_attempts")
        assert model.index == 1

    @pytest.mark.parametrize(
        ("limits", "exp_stop_reason"),
        [
            ({"turns": 1}, "limit_turns"),
            ({"output_tokens": 1}, "limit_output_tokens"),
            ({"total_tokens": 2}, "limit_total_tokens"),
        ],
    )
    @pytest.mark.asyncio
    async def test_invoke_async_reports_other_limits_before_attempt_limit(self, limits, exp_stop_reason):
        model = MockedModelProvider(
            [_structured_output_response({}, "output")],
            [{"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}],
        )
        agent = Agent(model=model, callback_handler=None)

        result = await agent.invoke_async(
            "Extract the data",
            structured_output_model=UserModel,
            limits={**limits, "structured_output_attempts": 1},
        )

        assert result.stop_reason == exp_stop_reason
        assert result.structured_output is None
        assert model.index == 1

    @pytest.mark.asyncio
    async def test_invoke_async_counts_one_attempt_per_response(self):
        failed = _structured_output_response({}, "invalid-1")
        failed["content"].extend(_structured_output_response({}, "invalid-2")["content"])
        model = MockedModelProvider([failed, _structured_output_response(VALID_USER, "valid")])
        agent = Agent(model=model, callback_handler=None)

        result = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 2}
        )

        assert result.structured_output == UserModel(**VALID_USER)
        assert model.index == 2

    @pytest.mark.asyncio
    async def test_invoke_async_does_not_count_other_tool_failures(self):
        @tool
        def unavailable_service() -> str:
            """Call a service that is temporarily unavailable."""
            raise RuntimeError("service unavailable")

        model = MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [
                        {"toolUse": {"toolUseId": "service", "name": unavailable_service.tool_name, "input": {}}}
                    ],
                },
                _structured_output_response(VALID_USER, "output"),
            ]
        )
        agent = Agent(model=model, tools=[unavailable_service], callback_handler=None)

        result = await agent.invoke_async(
            "Extract the data", structured_output_model=UserModel, limits={"structured_output_attempts": 1}
        )

        assert result.structured_output == UserModel(**VALID_USER)
        assert model.index == 2
