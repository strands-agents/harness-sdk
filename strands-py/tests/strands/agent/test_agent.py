import copy
import importlib
import json
import os
import textwrap
import threading
import unittest.mock
import warnings
from collections.abc import AsyncGenerator
from typing import Any
from uuid import uuid4

import pytest
from pydantic import BaseModel

import strands
from strands import Agent, Plugin, ToolContext
from strands.agent import AgentResult
from strands.agent._agent_as_tool import _AgentAsTool
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
from strands.agent.state import AgentState
from strands.handlers.callback_handler import PrintingCallbackHandler, null_callback_handler
from strands.hooks import BeforeInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent
from strands.interrupt import Interrupt
from strands.memory import MemoryManager, MemoryManagerConfig
from strands.models.bedrock import DEFAULT_BEDROCK_MODEL_ID, BedrockModel
from strands.session.repository_session_manager import RepositorySessionManager
from strands.telemetry.tracer import serialize
from strands.types._events import EventLoopStopEvent, ModelStreamEvent
from strands.types.agent import ConcurrentInvocationMode
from strands.types.content import Messages
from strands.types.exceptions import (
    CheckpointException,
    ConcurrencyException,
    ContextWindowOverflowException,
    EventLoopException,
)
from strands.types.session import Session, SessionAgent, SessionMessage, SessionType
from tests.fixtures.mock_session_repository import MockedSessionRepository
from tests.fixtures.mocked_model_provider import MockedModelProvider

# For unit testing we will use the the us inference
FORMATTED_DEFAULT_MODEL_ID = DEFAULT_BEDROCK_MODEL_ID


@pytest.fixture
def mock_model(request):
    async def stream(*args, **kwargs):
        # Skip deep copy of invocation_state which contains non-serializable objects (agent, spans, etc.)
        copied_kwargs = {
            key: value if key == "invocation_state" else copy.deepcopy(value) for key, value in kwargs.items()
        }
        result = mock.mock_stream(*copy.deepcopy(args), **copied_kwargs)
        # If result is already an async generator, yield from it
        if hasattr(result, "__aiter__"):
            async for item in result:
                yield item
        else:
            # If result is a regular generator or iterable, convert to async
            for item in result:
                yield item

    mock = unittest.mock.Mock(spec=getattr(request, "param", None))
    mock.configure_mock(mock_stream=unittest.mock.MagicMock())
    mock.stream.side_effect = stream
    mock.stateful = False

    return mock


@pytest.fixture
def system_prompt(request):
    return request.param if hasattr(request, "param") else "You are a helpful assistant."


@pytest.fixture
def callback_handler():
    return unittest.mock.Mock()


@pytest.fixture
def messages(request):
    return request.param if hasattr(request, "param") else []


@pytest.fixture
def mock_event_loop_cycle():
    with unittest.mock.patch("strands.agent.agent.event_loop_cycle") as mock:
        yield mock


@pytest.fixture
def tool_registry():
    return strands.tools.registry.ToolRegistry()


@pytest.fixture
def tool_decorated():
    @strands.tools.tool(name="tool_decorated")
    def function(random_string: str) -> str:
        return random_string

    return function


@pytest.fixture
def tool_module(tmp_path):
    tool_definition = textwrap.dedent("""
        TOOL_SPEC = {
            "name": "tool_module",
            "description": "tool module",
            "inputSchema": {
                "type": "object",
                "properties": {},
            },
        }

        def tool_module():
            return
    """)
    tool_path = tmp_path / "tool_module.py"
    tool_path.write_text(tool_definition)

    return str(tool_path)


@pytest.fixture
def tool_imported(tmp_path, monkeypatch):
    tool_definition = textwrap.dedent("""
        TOOL_SPEC = {
            "name": "tool_imported",
            "description": "tool imported",
            "inputSchema": {
                "type": "object",
                "properties": {},
            },
        }

        def tool_imported():
            return
    """)
    tool_path = tmp_path / "tool_imported.py"
    tool_path.write_text(tool_definition)

    init_path = tmp_path / "__init__.py"
    init_path.touch()

    monkeypatch.syspath_prepend(str(tmp_path))

    dot_path = ".".join(os.path.splitext(tool_path)[0].split(os.sep)[-1:])
    return importlib.import_module(dot_path)


@pytest.fixture
def tool(tool_decorated, tool_registry):
    tool_registry.register_tool(tool_decorated)
    return tool_decorated


@pytest.fixture
def tools(request, tool):
    return request.param if hasattr(request, "param") else [tool_decorated]


@pytest.fixture
def agent(
    mock_model,
    system_prompt,
    callback_handler,
    messages,
    tools,
    tool,
    tool_registry,
    tool_decorated,
    request,
):
    agent = Agent(
        model=mock_model,
        system_prompt=system_prompt,
        callback_handler=callback_handler,
        messages=messages,
        tools=tools,
    )

    # Only register the tool directly if tools wasn't parameterized
    if not hasattr(request, "param") or request.param is None:
        # Create a new function tool directly from the decorated function
        agent.tool_registry.register_tool(tool_decorated)

    return agent


@pytest.fixture
def user():
    class User(BaseModel):
        name: str
        age: int
        email: str

    return User(name="Jane Doe", age=30, email="jane@doe.com")


class SyncEventMockedModel(MockedModelProvider):
    """A mock model that uses events to synchronize concurrent threads.

    This model signals when it starts streaming and waits for a proceed signal,
    allowing deterministic testing of concurrent behavior without relying on sleeps.
    """

    def __init__(self, agent_responses):
        super().__init__(agent_responses)
        self.started_event = threading.Event()
        self.proceed_event = threading.Event()

    async def stream(
        self, messages, tool_specs=None, system_prompt=None, tool_choice=None, **kwargs
    ) -> AsyncGenerator[Any, None]:
        # Signal that streaming has started
        self.started_event.set()
        # Wait for signal to proceed
        self.proceed_event.wait()
        async for event in super().stream(messages, tool_specs, system_prompt, tool_choice, **kwargs):
            yield event


class SyncEventFailingModel:
    """A mock model that signals when streaming starts, then raises an error.

    Used for testing idempotency behavior when the original invocation fails.
    """

    stateful = False

    def __init__(self):
        self.started_event = threading.Event()
        self.proceed_event = threading.Event()

    async def stream(self, *args, **kwargs):
        self.started_event.set()
        self.proceed_event.wait()
        raise RuntimeError("Simulated model failure")
        yield  # noqa: RET503 - makes this an async generator


class IdempotencyTestAgent(Agent):
    """Agent subclass that signals when a duplicate idempotency token is detected.

    Pairs with SyncEventMockedModel to provide deterministic two-thread synchronization:
    the model pauses Thread 1 inside stream(), and this class signals when Thread 2
    has reached the concurrency controller and been identified as a duplicate.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.duplicate_detected = threading.Event()
        original_begin = self._concurrency.begin

        def begin_with_signal(token):
            result = original_begin(token)
            if result.waiting_on is not None:
                self.duplicate_detected.set()
            return result

        self._concurrency.begin = begin_with_signal


def test_agent__init__tool_loader_format(tool_decorated, tool_module, tool_imported, tool_registry):
    _ = tool_registry

    agent = Agent(tools=[tool_decorated, tool_module, tool_imported])

    tru_tool_names = sorted(tool_spec["name"] for tool_spec in agent.tool_registry.get_all_tool_specs())
    exp_tool_names = ["tool_decorated", "tool_imported", "tool_module"]

    assert tru_tool_names == exp_tool_names


def test_agent__init__tool_loader_dict(tool_module, tool_registry):
    _ = tool_registry

    agent = Agent(tools=[{"name": "tool_module", "path": tool_module}])

    tru_tool_names = sorted(tool_spec["name"] for tool_spec in agent.tool_registry.get_all_tool_specs())
    exp_tool_names = ["tool_module"]

    assert tru_tool_names == exp_tool_names


def test_agent__init__with_default_model():
    agent = Agent()

    assert isinstance(agent.model, BedrockModel)
    assert agent.model.config["model_id"] == FORMATTED_DEFAULT_MODEL_ID


def test_agent__init__with_explicit_model(mock_model):
    agent = Agent(model=mock_model)

    assert agent.model == mock_model


def test_agent__init__with_string_model_id():
    agent = Agent(model="nonsense")

    assert isinstance(agent.model, BedrockModel)
    assert agent.model.config["model_id"] == "nonsense"


def test_agent__init__nested_tools_flattening(tool_decorated, tool_module, tool_imported, tool_registry):
    _ = tool_registry
    # Nested structure: [tool_decorated, [tool_module, [tool_imported]]]
    agent = Agent(tools=[tool_decorated, [tool_module, [tool_imported]]])
    tru_tool_names = sorted(agent.tool_names)
    exp_tool_names = ["tool_decorated", "tool_imported", "tool_module"]
    assert tru_tool_names == exp_tool_names


def test_agent__init__deeply_nested_tools(tool_decorated, tool_module, tool_imported, tool_registry):
    _ = tool_registry
    # Deeply nested structure
    nested_tools = [[[[tool_decorated]], [[tool_module]], tool_imported]]
    agent = Agent(tools=nested_tools)
    tru_tool_names = sorted(agent.tool_names)
    exp_tool_names = ["tool_decorated", "tool_imported", "tool_module"]
    assert tru_tool_names == exp_tool_names


@pytest.mark.parametrize(
    "agent_id",
    [
        "a/../b",
        "a/b",
    ],
)
def test_agent__init__invalid_id(agent_id):
    with pytest.raises(ValueError, match=f"agent_id={agent_id} | id cannot contain path separators"):
        Agent(agent_id=agent_id)


def test_agent__call__(
    mock_model,
    system_prompt,
    callback_handler,
    agent,
    tool,
    agenerator,
):
    conversation_manager_spy = unittest.mock.Mock(wraps=agent.conversation_manager)
    agent.conversation_manager = conversation_manager_spy

    mock_model.mock_stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_spec["name"],
                            },
                        },
                    },
                },
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "abcdEfghI123"}'}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    result = agent("test message")

    tru_result = {
        "message": result.message,
        "state": result.state,
        "stop_reason": result.stop_reason,
    }
    exp_result = {
        "message": {
            "content": [{"text": "test text"}],
            "role": "assistant",
            "metadata": unittest.mock.ANY,
            "tracking_id": unittest.mock.ANY,
        },
        "state": {},
        "stop_reason": "end_turn",
    }

    assert tru_result == exp_result

    mock_model.mock_stream.assert_has_calls(
        [
            unittest.mock.call(
                [
                    {
                        "role": "user",
                        "content": [
                            {"text": "test message"},
                        ],
                    },
                ],
                [tool.tool_spec],
                system_prompt,
                tool_choice=None,
                system_prompt_content=[{"text": system_prompt}],
                invocation_state=unittest.mock.ANY,
                model_state=unittest.mock.ANY,
            ),
            unittest.mock.call(
                [
                    {
                        "role": "user",
                        "content": [
                            {"text": "test message"},
                        ],
                    },
                    {
                        "role": "assistant",
                        "content": [
                            {
                                "toolUse": {
                                    "toolUseId": "t1",
                                    "name": tool.tool_spec["name"],
                                    "input": {"random_string": "abcdEfghI123"},
                                },
                            },
                        ],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "toolResult": {
                                    "toolUseId": "t1",
                                    "status": "success",
                                    "content": [{"text": "abcdEfghI123"}],
                                },
                            },
                        ],
                    },
                ],
                [tool.tool_spec],
                system_prompt,
                tool_choice=None,
                system_prompt_content=[{"text": system_prompt}],
                invocation_state=unittest.mock.ANY,
                model_state=unittest.mock.ANY,
            ),
        ],
    )

    callback_handler.assert_called()
    conversation_manager_spy.apply_management.assert_called_with(agent)


def test_agent__call__passes_invocation_state(mock_model, agent, tool, mock_event_loop_cycle, agenerator):
    mock_model.mock_stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_spec["name"],
                            },
                        },
                    },
                },
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
    ]

    override_system_prompt = "Override system prompt"
    override_model = unittest.mock.Mock()
    override_event_loop_metrics = unittest.mock.Mock()
    override_callback_handler = unittest.mock.Mock()
    override_tool_handler = unittest.mock.Mock()
    override_messages = [{"role": "user", "content": [{"text": "override msg"}]}]
    override_tool_config = {"test": "config"}

    async def check_invocation_state(**kwargs):
        invocation_state = kwargs["invocation_state"]
        assert invocation_state["some_value"] == "a_value"
        assert invocation_state["system_prompt"] == override_system_prompt
        assert invocation_state["model"] == override_model
        assert invocation_state["event_loop_metrics"] == override_event_loop_metrics
        assert invocation_state["callback_handler"] == override_callback_handler
        assert invocation_state["tool_handler"] == override_tool_handler
        assert invocation_state["messages"] == override_messages
        assert invocation_state["tool_config"] == override_tool_config
        assert invocation_state["agent"] == agent

        # Return expected values from event_loop_cycle
        yield EventLoopStopEvent("stop", {"role": "assistant", "content": [{"text": "Response"}]}, {}, {})

    mock_event_loop_cycle.side_effect = check_invocation_state

    agent(
        "test message",
        some_value="a_value",
        system_prompt=override_system_prompt,
        model=override_model,
        event_loop_metrics=override_event_loop_metrics,
        callback_handler=override_callback_handler,
        tool_handler=override_tool_handler,
        messages=override_messages,
        tool_config=override_tool_config,
    )

    mock_event_loop_cycle.assert_called_once()


def test_agent__call__retry_with_reduced_context(mock_model, agent, tool, agenerator):
    conversation_manager_spy = unittest.mock.Mock(wraps=agent.conversation_manager)
    agent.conversation_manager = conversation_manager_spy

    messages: Messages = [
        {"role": "user", "content": [{"text": "Hello!"}]},
        {
            "role": "assistant",
            "content": [{"text": "Hi!"}],
        },
        {"role": "user", "content": [{"text": "Whats your favorite color?"}]},
        {
            "role": "assistant",
            "content": [{"text": "Blue!"}],
        },
    ]
    agent.messages = messages

    mock_model.mock_stream.side_effect = [
        ContextWindowOverflowException(RuntimeError("Input is too long for requested model")),
        agenerator(
            [
                {
                    "contentBlockStart": {"start": {}},
                },
                {"contentBlockDelta": {"delta": {"text": "Green!"}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "end_turn"}},
            ]
        ),
    ]

    agent("And now?")

    expected_messages = [
        {"role": "user", "content": [{"text": "Whats your favorite color?"}]},
        {
            "role": "assistant",
            "content": [{"text": "Blue!"}],
        },
        {
            "role": "user",
            "content": [
                {"text": "And now?"},
            ],
        },
    ]

    mock_model.mock_stream.assert_called_with(
        expected_messages,
        unittest.mock.ANY,
        unittest.mock.ANY,
        tool_choice=None,
        system_prompt_content=unittest.mock.ANY,
        invocation_state=unittest.mock.ANY,
        model_state=unittest.mock.ANY,
    )

    conversation_manager_spy.reduce_context.assert_called_once()
    assert conversation_manager_spy.apply_management.call_count == 1


def test_agent__call__always_sliding_window_conversation_manager_doesnt_infinite_loop(
    mock_model, agent, tool, quiet_strands_logging
):
    conversation_manager = SlidingWindowConversationManager(window_size=500, should_truncate_results=False)
    conversation_manager_spy = unittest.mock.Mock(wraps=conversation_manager)
    agent.conversation_manager = conversation_manager_spy

    messages: Messages = [
        {"role": "user", "content": [{"text": "Hello!"}]},
        {
            "role": "assistant",
            "content": [{"text": "Hi!"}],
        },
        {"role": "user", "content": [{"text": "Whats your favorite color?"}]},
    ] * 1000
    agent.messages = messages

    mock_model.mock_stream.side_effect = ContextWindowOverflowException(
        RuntimeError("Input is too long for requested model")
    )

    with pytest.raises(ContextWindowOverflowException):
        agent("Test!")

    assert conversation_manager_spy.reduce_context.call_count > 0
    assert conversation_manager_spy.apply_management.call_count == 1


def test_agent__call__null_conversation_window_manager__doesnt_infinite_loop(
    mock_model, agent, tool, quiet_strands_logging
):
    agent.conversation_manager = NullConversationManager()

    messages: Messages = [
        {"role": "user", "content": [{"text": "Hello!"}]},
        {
            "role": "assistant",
            "content": [{"text": "Hi!"}],
        },
        {"role": "user", "content": [{"text": "Whats your favorite color?"}]},
    ] * 1000
    agent.messages = messages

    mock_model.mock_stream.side_effect = ContextWindowOverflowException(
        RuntimeError("Input is too long for requested model")
    )

    with pytest.raises(ContextWindowOverflowException):
        agent("Test!")


def test_agent__call__tool_truncation_doesnt_infinite_loop(mock_model, agent):
    messages: Messages = [
        {"role": "user", "content": [{"text": "Hello!"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "123", "input": {"hello": "world"}, "name": "test"}}],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "123", "content": [{"text": "Some large input!"}], "status": "success"}}
            ],
        },
    ]
    agent.messages = messages

    mock_model.mock_stream.side_effect = ContextWindowOverflowException(
        RuntimeError("Input is too long for requested model")
    )

    with pytest.raises(ContextWindowOverflowException):
        agent("Test!")


def test_agent__call__retry_with_overwritten_tool(mock_model, agent, tool, agenerator):
    conversation_manager_spy = unittest.mock.Mock(wraps=agent.conversation_manager)
    agent.conversation_manager = conversation_manager_spy

    messages: Messages = [
        {"role": "user", "content": [{"text": "Hello!"}]},
        {
            "role": "assistant",
            "content": [{"text": "Hi!"}],
        },
    ]
    agent.messages = messages

    mock_model.mock_stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_spec["name"],
                            },
                        },
                    },
                },
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "' + "X" * 500 + '"}'}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        # Will truncate the tool result
        ContextWindowOverflowException(RuntimeError("Input is too long for requested model")),
        # Will reduce the context
        ContextWindowOverflowException(RuntimeError("Input is too long for requested model")),
        agenerator([]),
    ]

    agent("test message")

    large_input = "X" * 500
    truncated_text = large_input[:200] + "...\n\n... [truncated: 100 chars removed] ...\n\n..." + large_input[-200:]
    expected_messages = [
        {"role": "user", "content": [{"text": "test message"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "t1", "name": "tool_decorated", "input": {"random_string": large_input}}}
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": truncated_text}],
                    }
                }
            ],
        },
    ]

    mock_model.mock_stream.assert_called_with(
        expected_messages,
        unittest.mock.ANY,
        unittest.mock.ANY,
        tool_choice=None,
        system_prompt_content=unittest.mock.ANY,
        invocation_state=unittest.mock.ANY,
        model_state=unittest.mock.ANY,
    )

    assert conversation_manager_spy.reduce_context.call_count == 2
    assert conversation_manager_spy.apply_management.call_count == 1


def test_agent__call__invalid_tool_use_event_loop_exception(mock_model, agent, tool, agenerator):
    mock_model.mock_stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_spec["name"],
                            },
                        },
                    },
                },
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        RuntimeError,
    ]

    with pytest.raises(EventLoopException):
        agent("test message")


def test_agent__call__callback(mock_model, agent, callback_handler, agenerator):
    mock_model.mock_stream.return_value = agenerator(
        [
            {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "123", "name": "test"}}}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"value"}'}}}},
            {"contentBlockStop": {}},
            {"contentBlockStart": {"start": {}}},
            {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "value"}}}},
            {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "value"}}}},
            {"contentBlockStop": {}},
            {"contentBlockStart": {"start": {}}},
            {"contentBlockDelta": {"delta": {"text": "value"}}},
            {"contentBlockStop": {}},
        ]
    )

    agent("test")
    assert callback_handler.call_args_list == [
        unittest.mock.call(init_event_loop=True),
        unittest.mock.call(start=True),
        unittest.mock.call(start_event_loop=True),
        unittest.mock.call(event={"contentBlockStart": {"start": {"toolUse": {"toolUseId": "123", "name": "test"}}}}),
        unittest.mock.call(event={"contentBlockDelta": {"delta": {"toolUse": {"input": '{"value"}'}}}}),
        unittest.mock.call(
            type="tool_use_stream",
            agent=agent,
            current_tool_use={"toolUseId": "123", "name": "test", "input": {}},
            delta={"toolUse": {"input": '{"value"}'}},
            event_loop_cycle_id=unittest.mock.ANY,
            event_loop_cycle_span=unittest.mock.ANY,
            event_loop_cycle_trace=unittest.mock.ANY,
            request_state={},
        ),
        unittest.mock.call(event={"contentBlockStop": {}}),
        unittest.mock.call(event={"contentBlockStart": {"start": {}}}),
        unittest.mock.call(event={"contentBlockDelta": {"delta": {"reasoningContent": {"text": "value"}}}}),
        unittest.mock.call(
            agent=agent,
            delta={"reasoningContent": {"text": "value"}},
            event_loop_cycle_id=unittest.mock.ANY,
            event_loop_cycle_span=unittest.mock.ANY,
            event_loop_cycle_trace=unittest.mock.ANY,
            reasoning=True,
            reasoningText="value",
            request_state={},
        ),
        unittest.mock.call(event={"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "value"}}}}),
        unittest.mock.call(
            agent=agent,
            delta={"reasoningContent": {"signature": "value"}},
            event_loop_cycle_id=unittest.mock.ANY,
            event_loop_cycle_span=unittest.mock.ANY,
            event_loop_cycle_trace=unittest.mock.ANY,
            reasoning=True,
            reasoning_signature="value",
            request_state={},
        ),
        unittest.mock.call(event={"contentBlockStop": {}}),
        unittest.mock.call(event={"contentBlockStart": {"start": {}}}),
        unittest.mock.call(event={"contentBlockDelta": {"delta": {"text": "value"}}}),
        unittest.mock.call(
            agent=agent,
            data="value",
            delta={"text": "value"},
            event_loop_cycle_id=unittest.mock.ANY,
            event_loop_cycle_span=unittest.mock.ANY,
            event_loop_cycle_trace=unittest.mock.ANY,
            request_state={},
        ),
        unittest.mock.call(event={"contentBlockStop": {}}),
        unittest.mock.call(
            message={
                "role": "assistant",
                "content": [
                    {"toolUse": {"toolUseId": "123", "name": "test", "input": {}}},
                    {"reasoningContent": {"reasoningText": {"text": "value", "signature": "value"}}},
                    {"text": "value"},
                ],
                "metadata": unittest.mock.ANY,
                "tracking_id": unittest.mock.ANY,
            },
        ),
        unittest.mock.call(
            result=AgentResult(
                stop_reason="end_turn",
                message={
                    "role": "assistant",
                    "content": [
                        {"toolUse": {"toolUseId": "123", "name": "test", "input": {}}},
                        {"reasoningContent": {"reasoningText": {"text": "value", "signature": "value"}}},
                        {"text": "value"},
                    ],
                    "metadata": unittest.mock.ANY,
                    "tracking_id": unittest.mock.ANY,
                },
                metrics=unittest.mock.ANY,
                state={},
            ),
        ),
    ]


@pytest.mark.asyncio
async def test_agent__call__in_async_context(mock_model, agent, agenerator):
    mock_model.mock_stream.return_value = agenerator(
        [
            {
                "contentBlockStart": {"start": {}},
            },
            {"contentBlockDelta": {"delta": {"text": "abc"}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )

    result = agent("test")

    tru_message = result.message
    exp_message = {
        "content": [{"text": "abc"}],
        "role": "assistant",
        "metadata": unittest.mock.ANY,
        "tracking_id": unittest.mock.ANY,
    }
    assert tru_message == exp_message


@pytest.mark.asyncio
async def test_agent_invoke_async(mock_model, agent, agenerator):
    mock_model.mock_stream.return_value = agenerator(
        [
            {
                "contentBlockStart": {"start": {}},
            },
            {"contentBlockDelta": {"delta": {"text": "abc"}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )

    result = await agent.invoke_async("test")

    tru_message = result.message
    exp_message = {
        "content": [{"text": "abc"}],
        "role": "assistant",
        "metadata": unittest.mock.ANY,
        "tracking_id": unittest.mock.ANY,
    }
    assert tru_message == exp_message


@pytest.mark.asyncio
async def test_append_messages_assigns_durable_tracking_id(agent):
    message = {"role": "user", "content": [{"text": "hello"}]}

    await agent._append_messages(message)

    assert "tracking_id" in agent.messages[-1]
    assert isinstance(agent.messages[-1]["tracking_id"], str)


@pytest.mark.asyncio
async def test_append_messages_preserves_existing_id(agent):
    message = {"role": "user", "content": [{"text": "hello"}], "tracking_id": "caller-supplied"}

    await agent._append_messages(message)

    assert agent.messages[-1]["tracking_id"] == "caller-supplied"


@pytest.mark.asyncio
async def test_append_messages_id_visible_to_message_added_hook(agent):
    from strands.hooks import MessageAddedEvent

    observed_ids = []
    agent.hooks.add_callback(MessageAddedEvent, lambda event: observed_ids.append(event.message.get("tracking_id")))

    message = {"role": "user", "content": [{"text": "hello"}]}
    await agent._append_messages(message)

    # The id the hook observed is the same id that ends up on the stored message.
    assert observed_ids == [agent.messages[-1]["tracking_id"]]
    assert observed_ids[0] is not None


@pytest.mark.parametrize("tools", [None, [tool_decorated]], indirect=True)
def test_agent_tool_names(tools, agent):
    actual = agent.tool_names
    expected = list(agent.tool_registry.get_all_tools_config().keys())

    assert actual == expected


def test_agent_init_with_no_model_or_model_id():
    agent = Agent()
    assert agent.model is not None
    assert agent.model.get_config().get("model_id") == FORMATTED_DEFAULT_MODEL_ID


def test_agent_with_none_callback_handler_prints_nothing():
    agent = Agent()

    assert isinstance(agent.callback_handler, PrintingCallbackHandler)


def test_agent_with_callback_handler_none_uses_null_handler():
    agent = Agent(callback_handler=None)

    assert agent.callback_handler == null_callback_handler


def test_agent_callback_handler_not_provided_creates_new_instances():
    """Test that when callback_handler is not provided, new PrintingCallbackHandler instances are created."""
    # Create two agents without providing callback_handler
    agent1 = Agent()
    agent2 = Agent()

    # Both should have PrintingCallbackHandler instances
    assert isinstance(agent1.callback_handler, PrintingCallbackHandler)
    assert isinstance(agent2.callback_handler, PrintingCallbackHandler)

    # But they should be different object instances
    assert agent1.callback_handler is not agent2.callback_handler


def test_agent_callback_handler_explicit_none_uses_null_handler():
    """Test that when callback_handler is explicitly set to None, null_callback_handler is used."""
    agent = Agent(callback_handler=None)

    # Should use null_callback_handler
    assert agent.callback_handler is null_callback_handler


def test_agent_callback_handler_custom_handler_used():
    """Test that when a custom callback_handler is provided, it is used."""
    custom_handler = unittest.mock.Mock()
    agent = Agent(callback_handler=custom_handler)

    # Should use the provided custom handler
    assert agent.callback_handler is custom_handler


def test_agent_structured_output(agent, system_prompt, user, agenerator):
    # Setup mock tracer and span
    mock_strands_tracer = unittest.mock.MagicMock()
    mock_otel_tracer = unittest.mock.MagicMock()
    mock_span = unittest.mock.MagicMock()
    mock_strands_tracer.tracer = mock_otel_tracer
    mock_otel_tracer.start_as_current_span.return_value.__enter__.return_value = mock_span
    agent.tracer = mock_strands_tracer

    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    prompt = "Jane Doe is 30 years old and her email is jane@doe.com"

    # Store initial message count
    initial_message_count = len(agent.messages)

    tru_result = agent.structured_output(type(user), prompt)
    exp_result = user
    assert tru_result == exp_result

    # Verify conversation history is not polluted
    assert len(agent.messages) == initial_message_count

    # Verify the model was called with temporary messages array
    agent.model.structured_output.assert_called_once_with(
        type(user), [{"role": "user", "content": [{"text": prompt}]}], system_prompt=system_prompt
    )

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.system": "strands-agents",
            "gen_ai.agent.name": "Strands Agents",
            "gen_ai.agent.id": "default",
            "gen_ai.operation.name": "execute_structured_output",
        }
    )

    # ensure correct otel event messages are emitted
    act_event_names = mock_span.add_event.call_args_list
    exp_event_names = [
        unittest.mock.call(
            "gen_ai.system.message", attributes={"role": "system", "content": serialize([{"text": system_prompt}])}
        ),
        unittest.mock.call(
            "gen_ai.user.message",
            attributes={
                "role": "user",
                "content": '[{"text": "Jane Doe is 30 years old and her email is jane@doe.com"}]',
            },
        ),
        unittest.mock.call("gen_ai.choice", attributes={"message": json.dumps(user.model_dump())}),
    ]

    assert act_event_names == exp_event_names


def test_agent_structured_output_multi_modal_input(agent, system_prompt, user, agenerator):
    # Setup mock tracer and span
    mock_strands_tracer = unittest.mock.MagicMock()
    mock_otel_tracer = unittest.mock.MagicMock()
    mock_span = unittest.mock.MagicMock()
    mock_strands_tracer.tracer = mock_otel_tracer
    mock_otel_tracer.start_as_current_span.return_value.__enter__.return_value = mock_span
    agent.tracer = mock_strands_tracer
    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    prompt = [
        {"text": "Please describe the user in this image"},
        {
            "image": {
                "format": "png",
                "source": {
                    "bytes": b"\x89PNG\r\n\x1a\n",
                },
            }
        },
    ]

    # Store initial message count
    initial_message_count = len(agent.messages)

    tru_result = agent.structured_output(type(user), prompt)
    exp_result = user
    assert tru_result == exp_result

    # Verify conversation history is not polluted
    assert len(agent.messages) == initial_message_count

    # Verify the model was called with temporary messages array
    agent.model.structured_output.assert_called_once_with(
        type(user), [{"role": "user", "content": prompt}], system_prompt=system_prompt
    )

    mock_span.add_event.assert_called_with(
        "gen_ai.choice",
        attributes={"message": json.dumps(user.model_dump())},
    )


@pytest.mark.asyncio
async def test_agent_structured_output_in_async_context(agent, user, agenerator):
    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    prompt = "Jane Doe is 30 years old and her email is jane@doe.com"

    # Store initial message count
    initial_message_count = len(agent.messages)

    tru_result = await agent.structured_output_async(type(user), prompt)
    exp_result = user
    assert tru_result == exp_result

    # Verify conversation history is not polluted
    assert len(agent.messages) == initial_message_count


def test_agent_structured_output_without_prompt(agent, system_prompt, user, agenerator):
    """Test that structured_output works with existing conversation history and no new prompt."""
    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    # Add some existing messages to the agent
    existing_messages = [
        {"role": "user", "content": [{"text": "Jane Doe is 30 years old"}]},
        {"role": "assistant", "content": [{"text": "I understand."}]},
    ]
    agent.messages.extend(existing_messages)

    initial_message_count = len(agent.messages)

    tru_result = agent.structured_output(type(user))  # No prompt provided
    exp_result = user
    assert tru_result == exp_result

    # Verify conversation history is unchanged
    assert len(agent.messages) == initial_message_count
    assert agent.messages == existing_messages

    # Verify the model was called with existing messages only
    agent.model.structured_output.assert_called_once_with(type(user), existing_messages, system_prompt=system_prompt)


@pytest.mark.asyncio
async def test_agent_structured_output_async(agent, system_prompt, user, agenerator):
    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    prompt = "Jane Doe is 30 years old and her email is jane@doe.com"

    # Store initial message count
    initial_message_count = len(agent.messages)

    tru_result = agent.structured_output(type(user), prompt)
    exp_result = user
    assert tru_result == exp_result

    # Verify conversation history is not polluted
    assert len(agent.messages) == initial_message_count

    # Verify the model was called with temporary messages array
    agent.model.structured_output.assert_called_once_with(
        type(user), [{"role": "user", "content": [{"text": prompt}]}], system_prompt=system_prompt
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "system_prompt",
    [[{"text": "You are a helpful assistant."}, {"cachePoint": {"type": "default"}}]],
    indirect=True,
)
async def test_agent_structured_output_async_warns_on_dropped_system_prompt_blocks(agent, user, agenerator):
    """Non-text system prompt blocks are dropped on this path, so the caller is told instead of failing silently."""
    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await agent.structured_output_async(type(user), "Jane Doe is 30 years old")

    dropped_warnings = [
        warning
        for warning in caught
        if issubclass(warning.category, UserWarning) and "cachePoint" in str(warning.message)
    ]
    assert len(dropped_warnings) == 1

    # The provider still only receives the flattened string; this path is deprecated and is not being widened.
    agent.model.structured_output.assert_called_once_with(
        type(user),
        [{"role": "user", "content": [{"text": "Jane Doe is 30 years old"}]}],
        system_prompt="You are a helpful assistant.",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("system_prompt", ["You are a helpful assistant."], indirect=True)
async def test_agent_structured_output_async_does_not_warn_for_plain_system_prompt(agent, user, agenerator):
    """A plain string system prompt loses nothing, so it must stay quiet."""
    agent.model.structured_output = unittest.mock.Mock(return_value=agenerator([{"output": user}]))

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await agent.structured_output_async(type(user), "Jane Doe is 30 years old")

    assert [warning for warning in caught if issubclass(warning.category, UserWarning)] == []


@pytest.mark.asyncio
async def test_stream_async_returns_all_events(mock_event_loop_cycle, alist):
    agent = Agent()

    # Define the side effect to simulate callback handler being called multiple times
    async def test_event_loop(*args, **kwargs):
        yield ModelStreamEvent({"data": "First chunk"})
        yield ModelStreamEvent({"data": "Second chunk"})
        yield ModelStreamEvent({"data": "Final chunk", "complete": True})

        # Return expected values from event_loop_cycle
        yield EventLoopStopEvent("stop", {"role": "assistant", "content": [{"text": "Response"}]}, {}, {})

    mock_event_loop_cycle.side_effect = test_event_loop
    mock_callback = unittest.mock.Mock()

    stream = agent.stream_async("test message", callback_handler=mock_callback)

    tru_events = await alist(stream)
    exp_events = [
        {"init_event_loop": True, "callback_handler": mock_callback},
        {"data": "First chunk"},
        {"data": "Second chunk"},
        {"complete": True, "data": "Final chunk"},
        {
            "result": AgentResult(
                stop_reason="stop",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics={},
                state={},
            ),
        },
    ]
    assert tru_events == exp_events

    exp_calls = [unittest.mock.call(**event) for event in exp_events]
    mock_callback.assert_has_calls(exp_calls)


@pytest.mark.asyncio
async def test_stream_async_multi_modal_input(mock_model, agent, agenerator, alist):
    mock_model.mock_stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "I see text and an image"}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )

    prompt = [
        {"text": "This is a description of the image:"},
        {
            "image": {
                "format": "png",
                "source": {
                    "bytes": b"\x89PNG\r\n\x1a\n",
                },
            }
        },
    ]

    stream = agent.stream_async(prompt)
    await alist(stream)

    tru_message = agent.messages
    exp_message = [
        {"content": prompt, "role": "user", "tracking_id": unittest.mock.ANY},
        {
            "content": [{"text": "I see text and an image"}],
            "role": "assistant",
            "metadata": unittest.mock.ANY,
            "tracking_id": unittest.mock.ANY,
        },
    ]
    assert tru_message == exp_message


def test_system_prompt_setter_string():
    """Test that setting system_prompt with string updates both internal fields."""
    agent = Agent(system_prompt="initial prompt")

    agent.system_prompt = "updated prompt"

    assert agent.system_prompt == "updated prompt"
    assert agent._system_prompt_content == [{"text": "updated prompt"}]


def test_system_prompt_setter_list():
    """Test that setting system_prompt with list updates both internal fields."""
    agent = Agent()

    content_blocks = [{"text": "You are helpful"}, {"cache_control": {"type": "ephemeral"}}]
    agent.system_prompt = content_blocks

    assert agent.system_prompt == "You are helpful"
    assert agent._system_prompt_content == content_blocks


def test_system_prompt_setter_none():
    """Test that setting system_prompt to None clears both internal fields."""
    agent = Agent(system_prompt="initial prompt")

    agent.system_prompt = None

    assert agent.system_prompt is None
    assert agent._system_prompt_content is None


def test_system_prompt_content_string():
    """Test that system_prompt_content returns content blocks for string prompt."""
    agent = Agent(system_prompt="hello")
    assert agent.system_prompt_content == [{"text": "hello"}]


def test_system_prompt_content_structured():
    """Test that system_prompt_content returns structured blocks with cache points."""
    blocks = [{"text": "You are helpful"}, {"cachePoint": {"type": "default"}}]
    agent = Agent(system_prompt=blocks)
    assert agent.system_prompt_content == blocks


def test_system_prompt_content_none():
    """Test that system_prompt_content returns None when no prompt is set."""
    agent = Agent(system_prompt=None)
    assert agent.system_prompt_content is None


def test_system_prompt_content_returns_copy():
    """Test that system_prompt_content returns a defensive copy."""
    agent = Agent(system_prompt="hello")
    content = agent.system_prompt_content
    content.append({"text": "injected"})
    assert agent.system_prompt_content == [{"text": "hello"}]


@pytest.mark.asyncio
async def test_stream_async_passes_invocation_state(agent, mock_model, mock_event_loop_cycle, agenerator, alist):
    mock_model.mock_stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": "a_tool",
                            },
                        },
                    },
                },
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
    ]

    async def check_invocation_state(**kwargs):
        invocation_state = kwargs["invocation_state"]
        assert invocation_state["some_value"] == "a_value"
        # Return expected values from event_loop_cycle
        yield EventLoopStopEvent("stop", {"role": "assistant", "content": [{"text": "Response"}]}, {}, {})

    mock_event_loop_cycle.side_effect = check_invocation_state

    stream = agent.stream_async("test message", some_value="a_value")

    tru_events = await alist(stream)
    exp_events = [
        {"init_event_loop": True, "some_value": "a_value"},
        {
            "result": AgentResult(
                stop_reason="stop",
                message={"role": "assistant", "content": [{"text": "Response"}]},
                metrics={},
                state={},
            ),
        },
    ]
    assert tru_events == exp_events

    assert mock_event_loop_cycle.call_count == 1


@pytest.mark.asyncio
async def test_stream_async_raises_exceptions(mock_event_loop_cycle):
    mock_event_loop_cycle.side_effect = ValueError("Test exception")

    agent = Agent()
    stream = agent.stream_async("test message")

    await anext(stream)
    with pytest.raises(ValueError, match="Test exception"):
        await anext(stream)


def test_agent_init_with_trace_attributes():
    """Test that trace attributes are properly initialized in the Agent."""
    # Test with valid trace attributes
    valid_attributes = {
        "string_attr": "value",
        "int_attr": 123,
        "float_attr": 45.6,
        "bool_attr": True,
        "list_attr": ["item1", "item2"],
    }

    agent = Agent(trace_attributes=valid_attributes)

    # Check that all valid attributes were copied
    assert agent.trace_attributes == valid_attributes

    # Test with mixed valid and invalid trace attributes
    mixed_attributes = {
        "valid_str": "value",
        "invalid_dict": {"key": "value"},  # Should be filtered out
        "invalid_set": {1, 2, 3},  # Should be filtered out
        "valid_list": [1, 2, 3],  # Should be kept
        "invalid_nested_list": [1, {"nested": "dict"}],  # Should be filtered out
    }

    agent = Agent(trace_attributes=mixed_attributes)

    # Check that only valid attributes were copied
    assert "valid_str" in agent.trace_attributes
    assert "valid_list" in agent.trace_attributes
    assert "invalid_dict" not in agent.trace_attributes
    assert "invalid_set" not in agent.trace_attributes
    assert "invalid_nested_list" not in agent.trace_attributes


@unittest.mock.patch("strands.agent.agent.get_tracer")
def test_agent_init_initializes_tracer(mock_get_tracer):
    """Test that the tracer is initialized when creating an Agent."""
    mock_tracer = unittest.mock.MagicMock()
    mock_get_tracer.return_value = mock_tracer

    agent = Agent()

    # Verify tracer was initialized
    mock_get_tracer.assert_called_once()
    assert agent.tracer == mock_tracer
    assert agent.trace_span is None


@unittest.mock.patch("strands.agent.agent.get_tracer")
def test_agent_call_creates_and_ends_span_on_success(mock_get_tracer, mock_model, agenerator):
    """Test that __call__ creates and ends a span when the call succeeds."""
    # Setup mock tracer and span
    mock_tracer = unittest.mock.MagicMock()
    mock_span = unittest.mock.MagicMock()
    mock_tracer.start_agent_span.return_value = mock_span
    mock_get_tracer.return_value = mock_tracer

    # Setup mock model response
    mock_model.mock_stream.side_effect = [
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test response"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    # Create agent and make a call
    agent = Agent(model=mock_model)
    result = agent("test prompt")

    # Verify span was created
    mock_tracer.start_agent_span.assert_called_once_with(
        messages=[{"content": [{"text": "test prompt"}], "role": "user", "tracking_id": unittest.mock.ANY}],
        agent_name="Strands Agents",
        model_id=unittest.mock.ANY,
        tools=agent.tool_names,
        system_prompt=agent.system_prompt,
        custom_trace_attributes=agent.trace_attributes,
        tools_config=unittest.mock.ANY,
    )

    # Verify span was ended with the result
    mock_tracer.end_agent_span.assert_called_once_with(span=mock_span, response=result)


@pytest.mark.asyncio
@unittest.mock.patch("strands.agent.agent.get_tracer")
async def test_agent_stream_async_creates_and_ends_span_on_success(
    mock_get_tracer, mock_event_loop_cycle, mock_model, alist
):
    """Test that stream_async creates and ends a span when the call succeeds."""
    # Setup mock tracer and span
    mock_tracer = unittest.mock.MagicMock()
    mock_span = unittest.mock.MagicMock()
    mock_tracer.start_agent_span.return_value = mock_span
    mock_get_tracer.return_value = mock_tracer

    async def test_event_loop(*args, **kwargs):
        yield EventLoopStopEvent("stop", {"role": "assistant", "content": [{"text": "Agent Response"}]}, {}, {})

    mock_event_loop_cycle.side_effect = test_event_loop

    # Create agent and make a call
    agent = Agent(model=mock_model)
    stream = agent.stream_async("test prompt")
    await alist(stream)

    # Verify span was created
    mock_tracer.start_agent_span.assert_called_once_with(
        messages=[{"content": [{"text": "test prompt"}], "role": "user", "tracking_id": unittest.mock.ANY}],
        agent_name="Strands Agents",
        model_id=unittest.mock.ANY,
        tools=agent.tool_names,
        system_prompt=agent.system_prompt,
        custom_trace_attributes=agent.trace_attributes,
        tools_config=unittest.mock.ANY,
    )

    expected_response = AgentResult(
        stop_reason="stop", message={"role": "assistant", "content": [{"text": "Agent Response"}]}, metrics={}, state={}
    )

    # Verify span was ended with the result
    mock_tracer.end_agent_span.assert_called_once_with(span=mock_span, response=expected_response)


@unittest.mock.patch("strands.agent.agent.get_tracer")
def test_agent_call_creates_and_ends_span_on_exception(mock_get_tracer, mock_model):
    """Test that __call__ creates and ends a span when an exception occurs."""
    # Setup mock tracer and span
    mock_tracer = unittest.mock.MagicMock()
    mock_span = unittest.mock.MagicMock()
    mock_tracer.start_agent_span.return_value = mock_span
    mock_get_tracer.return_value = mock_tracer

    # Setup mock model to raise an exception
    test_exception = ValueError("Test exception")
    mock_model.mock_stream.side_effect = test_exception

    # Create agent and make a call that will raise an exception
    agent = Agent(model=mock_model)

    # Call the agent and catch the exception
    with pytest.raises(ValueError):
        agent("test prompt")

    # Verify span was created
    mock_tracer.start_agent_span.assert_called_once_with(
        messages=[{"content": [{"text": "test prompt"}], "role": "user", "tracking_id": unittest.mock.ANY}],
        agent_name="Strands Agents",
        model_id=unittest.mock.ANY,
        tools=agent.tool_names,
        system_prompt=agent.system_prompt,
        custom_trace_attributes=agent.trace_attributes,
        tools_config=unittest.mock.ANY,
    )

    # Verify span was ended with the exception
    mock_tracer.end_agent_span.assert_called_once_with(span=mock_span, error=test_exception)


@pytest.mark.asyncio
@unittest.mock.patch("strands.agent.agent.get_tracer")
async def test_agent_stream_async_creates_and_ends_span_on_exception(mock_get_tracer, mock_model, alist):
    """Test that stream_async creates and ends a span when the call succeeds."""
    # Setup mock tracer and span
    mock_tracer = unittest.mock.MagicMock()
    mock_span = unittest.mock.MagicMock()
    mock_tracer.start_agent_span.return_value = mock_span
    mock_get_tracer.return_value = mock_tracer

    # Define the side effect to simulate callback handler raising an Exception
    test_exception = ValueError("Test exception")
    mock_model.mock_stream.side_effect = test_exception

    # Create agent and make a call
    agent = Agent(model=mock_model)

    # Call the agent and catch the exception
    with pytest.raises(ValueError):
        stream = agent.stream_async("test prompt")
        await alist(stream)

    # Verify span was created
    mock_tracer.start_agent_span.assert_called_once_with(
        messages=[{"content": [{"text": "test prompt"}], "role": "user", "tracking_id": unittest.mock.ANY}],
        agent_name="Strands Agents",
        model_id=unittest.mock.ANY,
        tools=agent.tool_names,
        system_prompt=agent.system_prompt,
        custom_trace_attributes=agent.trace_attributes,
        tools_config=unittest.mock.ANY,
    )

    # Verify span was ended with the exception
    mock_tracer.end_agent_span.assert_called_once_with(span=mock_span, error=test_exception)


def test_agent_init_with_state_object():
    agent = Agent(state=AgentState({"foo": "bar"}))
    assert agent.state.get("foo") == "bar"


def test_non_dict_throws_error():
    with pytest.raises(ValueError, match="state must be an AgentState object or a dict"):
        agent = Agent(state={"object", object()})
        print(agent.state)


def test_non_json_serializable_state_throws_error():
    with pytest.raises(ValueError, match="Value is not JSON serializable"):
        agent = Agent(state={"object": object()})
        print(agent.state)


def test_agent_state_breaks_dict_reference():
    ref_dict = {"hello": "world"}
    agent = Agent(state=ref_dict)

    # Make sure shallow object references do not affect state maintained by AgentState
    ref_dict["hello"] = object()

    # This will fail if AgentState reflects the updated reference
    json.dumps(agent.state.get())


def test_agent_state_breaks_deep_dict_reference():
    ref_dict = {"world": "!"}
    init_dict = {"hello": ref_dict}
    agent = Agent(state=init_dict)
    # Make sure deep reference changes do not affect state mained by AgentState
    ref_dict["world"] = object()

    # This will fail if AgentState reflects the updated reference
    json.dumps(agent.state.get())


def test_agent_state_set_breaks_dict_reference():
    agent = Agent()
    ref_dict = {"hello": "world"}
    # Set should copy the input, and not maintain the reference to the original object
    agent.state.set("hello", ref_dict)
    ref_dict["hello"] = object()

    # This will fail if AgentState reflects the updated reference
    json.dumps(agent.state.get())


def test_agent_state_get_breaks_deep_dict_reference():
    agent = Agent(state={"hello": {"world": "!"}})
    # Get should not return a reference to the internal state
    ref_state = agent.state.get()
    ref_state["hello"]["world"] = object()

    # This will fail if AgentState reflects the updated reference
    json.dumps(agent.state.get())


def test_agent_session_management():
    mock_session_repository = MockedSessionRepository()
    session_manager = RepositorySessionManager(session_id="123", session_repository=mock_session_repository)
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "hello!"}]}])
    agent = Agent(session_manager=session_manager, model=model)
    agent("Hello!")


def test_agent_restored_from_session_management():
    mock_session_repository = MockedSessionRepository()
    mock_session_repository.create_session(Session(session_id="123", session_type=SessionType.AGENT))
    mock_session_repository.create_agent(
        "123",
        SessionAgent(
            agent_id="default",
            state={"foo": "bar"},
            conversation_manager_state=SlidingWindowConversationManager().get_state(),
        ),
    )
    session_manager = RepositorySessionManager(session_id="123", session_repository=mock_session_repository)

    agent = Agent(session_manager=session_manager)

    assert agent.state.get("foo") == "bar"


def test_agent_restored_from_session_management_with_message():
    mock_session_repository = MockedSessionRepository()
    mock_session_repository.create_session(Session(session_id="123", session_type=SessionType.AGENT))
    mock_session_repository.create_agent(
        "123",
        SessionAgent(
            agent_id="default",
            state={"foo": "bar"},
            conversation_manager_state=SlidingWindowConversationManager().get_state(),
        ),
    )
    mock_session_repository.create_message(
        "123", "default", SessionMessage({"role": "user", "content": [{"text": "Hello!"}]}, 0)
    )
    session_manager = RepositorySessionManager(session_id="123", session_repository=mock_session_repository)

    agent = Agent(session_manager=session_manager)

    assert agent.state.get("foo") == "bar"


def test_agent_redacts_input_on_triggered_guardrail():
    mocked_model = MockedModelProvider(
        [{"redactedUserContent": "BLOCKED!", "redactedAssistantContent": "INPUT BLOCKED!"}]
    )

    agent = Agent(
        model=mocked_model,
        system_prompt="You are a helpful assistant.",
        callback_handler=None,
    )

    response1 = agent("CACTUS")

    assert response1.stop_reason == "guardrail_intervened"
    assert agent.messages[0]["content"][0]["text"] == "BLOCKED!"


def test_agent_restored_from_session_management_with_redacted_input():
    mocked_model = MockedModelProvider(
        [{"redactedUserContent": "BLOCKED!", "redactedAssistantContent": "INPUT BLOCKED!"}]
    )

    test_session_id = str(uuid4())
    mocked_session_repository = MockedSessionRepository()
    session_manager = RepositorySessionManager(session_id=test_session_id, session_repository=mocked_session_repository)

    agent = Agent(
        model=mocked_model,
        system_prompt="You are a helpful assistant.",
        callback_handler=None,
        session_manager=session_manager,
    )

    assert mocked_session_repository.read_agent(test_session_id, agent.agent_id) is not None

    response1 = agent("CACTUS")

    assert response1.stop_reason == "guardrail_intervened"
    assert agent.messages[0]["content"][0]["text"] == "BLOCKED!"
    user_input_session_message = mocked_session_repository.list_messages(test_session_id, agent.agent_id)[0]
    # Assert persisted message is equal to the redacted message in the agent
    assert user_input_session_message.to_message() == agent.messages[0]

    # Restore an agent from the session, confirm input is still redacted
    session_manager_2 = RepositorySessionManager(
        session_id=test_session_id, session_repository=mocked_session_repository
    )
    agent_2 = Agent(
        model=mocked_model,
        system_prompt="You are a helpful assistant.",
        callback_handler=None,
        session_manager=session_manager_2,
    )

    # Assert that the restored agent redacted message is equal to the original agent
    assert agent.messages[0] == agent_2.messages[0]


def test_agent_restored_from_session_management_with_correct_index():
    mock_model_provider = MockedModelProvider(
        [{"role": "assistant", "content": [{"text": "hello!"}]}, {"role": "assistant", "content": [{"text": "world!"}]}]
    )
    mock_session_repository = MockedSessionRepository()
    session_manager = RepositorySessionManager(session_id="test", session_repository=mock_session_repository)
    agent = Agent(session_manager=session_manager, model=mock_model_provider)
    agent("Hello!")

    assert len(mock_session_repository.list_messages("test", agent.agent_id)) == 2

    session_manager_2 = RepositorySessionManager(session_id="test", session_repository=mock_session_repository)
    agent_2 = Agent(session_manager=session_manager_2, model=mock_model_provider)

    assert len(agent_2.messages) == 2
    assert agent_2.messages[1]["content"][0]["text"] == "hello!"

    agent_2("Hello!")

    assert len(agent_2.messages) == 4
    session_messages = mock_session_repository.list_messages("test", agent_2.agent_id)
    assert (len(session_messages)) == 4
    assert session_messages[1].message["content"][0]["text"] == "hello!"
    assert session_messages[3].message["content"][0]["text"] == "world!"


def test_agent_with_session_and_conversation_manager():
    mock_model = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "first"}]},
            {"role": "assistant", "content": [{"text": "second"}]},
        ]
    )
    mock_session_repository = MockedSessionRepository()
    session_manager = RepositorySessionManager(session_id="123", session_repository=mock_session_repository)
    conversation_manager = SlidingWindowConversationManager(window_size=2)
    # Create an agent with a mocked model and session repository
    agent = Agent(
        session_manager=session_manager,
        conversation_manager=conversation_manager,
        model=mock_model,
    )

    # Assert session was initialized
    assert mock_session_repository.read_session("123") is not None
    assert mock_session_repository.read_agent("123", agent.agent_id) is not None
    assert len(mock_session_repository.list_messages("123", agent.agent_id)) == 0

    agent("Hello!")

    # After first invocation: [user, assistant] — fits in window, no trimming
    assert len(mock_session_repository.list_messages("123", agent.agent_id)) == 2
    assert len(agent.messages) == 2

    agent("Second question")

    # After second invocation: [user, assistant, user, assistant] exceeds window_size=2
    # Conversation manager trims to 2 messages starting with a user message
    assert len(agent.messages) == 2
    assert agent.messages[0]["role"] == "user"

    # Initialize another agent using the same session
    session_manager_2 = RepositorySessionManager(session_id="123", session_repository=mock_session_repository)
    conversation_manager_2 = SlidingWindowConversationManager(window_size=2)
    agent_2 = Agent(
        session_manager=session_manager_2,
        conversation_manager=conversation_manager_2,
        model=mock_model,
    )
    # Assert that the second agent was initialized properly, and that the messages of both agents are equal
    assert agent.messages == agent_2.messages
    # Assert the conversation manager was initialized properly
    assert agent.conversation_manager.removed_message_count == agent_2.conversation_manager.removed_message_count


def test_agent_empty_invoke():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "hello!"}]}])
    agent = Agent(model=model, messages=[{"role": "user", "content": [{"text": "hello!"}]}])
    result = agent()
    assert str(result) == "hello!\n"
    assert len(agent.messages) == 2


def test_agent_empty_list_invoke():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "hello!"}]}])
    agent = Agent(model=model, messages=[{"role": "user", "content": [{"text": "hello!"}]}])
    result = agent([])
    assert str(result) == "hello!\n"
    assert len(agent.messages) == 2


def test_agent_with_assistant_role_message():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "world!"}]}])
    agent = Agent(model=model)
    assistant_message = [{"role": "assistant", "content": [{"text": "hello..."}]}]
    result = agent(assistant_message)
    assert str(result) == "world!\n"
    assert len(agent.messages) == 2


def test_agent_with_multiple_messages_on_invoke():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "world!"}]}])
    agent = Agent(model=model)
    input_messages = [
        {"role": "user", "content": [{"text": "hello"}]},
        {"role": "assistant", "content": [{"text": "..."}]},
    ]
    result = agent(input_messages)
    assert str(result) == "world!\n"
    assert len(agent.messages) == 3


def test_agent_with_invalid_input():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "world!"}]}])
    agent = Agent(model=model)
    with pytest.raises(ValueError, match="Input prompt must be of type: `str | list[Contentblock] | Messages | None`."):
        agent({"invalid": "input"})


def test_agent_with_invalid_input_list():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "world!"}]}])
    agent = Agent(model=model)
    with pytest.raises(ValueError, match="Input prompt must be of type: `str | list[Contentblock] | Messages | None`."):
        agent([{"invalid": "input"}])


def test_agent_with_list_of_message_and_content_block():
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "world!"}]}])
    agent = Agent(model=model)
    with pytest.raises(ValueError, match="Input prompt must be of type: `str | list[Contentblock] | Messages | None`."):
        agent([{"role": "user", "content": [{"text": "hello"}]}, {"text", "hello"}])


def test_agent__call__handles_none_invocation_state(mock_model, agent):
    """Test that agent handles None invocation_state without AttributeError."""
    mock_model.mock_stream.return_value = [
        {"contentBlockDelta": {"delta": {"text": "test response"}}},
        {"contentBlockStop": {}},
    ]

    # This should not raise AttributeError: 'NoneType' object has no attribute 'get'
    result = agent("test", invocation_state=None)

    assert result.message["content"][0]["text"] == "test response"
    assert result.stop_reason == "end_turn"


def test_agent__call__invocation_state_with_kwargs_deprecation_warning(agent, mock_event_loop_cycle):
    """Test that kwargs trigger deprecation warning and are merged correctly with invocation_state."""

    async def check_invocation_state(**kwargs):
        invocation_state = kwargs["invocation_state"]
        # Should have nested structure when both invocation_state and kwargs are provided
        assert invocation_state["invocation_state"] == {"my": "state"}
        assert invocation_state["other_kwarg"] == "foobar"
        yield EventLoopStopEvent("stop", {"role": "assistant", "content": [{"text": "Response"}]}, {}, {})

    mock_event_loop_cycle.side_effect = check_invocation_state

    with warnings.catch_warnings(record=True) as captured_warnings:
        warnings.simplefilter("always")
        agent("hello!", invocation_state={"my": "state"}, other_kwarg="foobar")

    # Verify deprecation warning was issued
    assert len(captured_warnings) == 1
    assert issubclass(captured_warnings[0].category, UserWarning)
    assert "`**kwargs` parameter is deprecating, use `invocation_state` instead." in str(captured_warnings[0].message)


def test_agent__call__invocation_state_only_no_warning(agent, mock_event_loop_cycle):
    """Test that using only invocation_state does not trigger warning and passes state directly."""

    async def check_invocation_state(**kwargs):
        invocation_state = kwargs["invocation_state"]

        assert invocation_state["my"] == "state"
        assert "agent" in invocation_state
        yield EventLoopStopEvent("stop", {"role": "assistant", "content": [{"text": "Response"}]}, {}, {})

    mock_event_loop_cycle.side_effect = check_invocation_state

    with warnings.catch_warnings(record=True) as captured_warnings:
        warnings.simplefilter("always")
        agent("hello!", invocation_state={"my": "state"})

    assert len(captured_warnings) == 0


def test_agent__call__resume_interrupt(mock_model, tool_decorated, agenerator):
    tool_use_message = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "toolUseId": "t1",
                    "name": "tool_decorated",
                    "input": {"random_string": "test input"},
                }
            },
        ],
    }
    agent = Agent(
        messages=[tool_use_message],
        model=mock_model,
        tools=[tool_decorated],
    )

    interrupt = Interrupt(
        id="v1:before_tool_call:t1:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
    )

    agent._interrupt_state.context = {"tool_use_message": tool_use_message, "tool_results": []}
    agent._interrupt_state.interrupts[interrupt.id] = interrupt
    agent._interrupt_state.activate()

    interrupt_response = {}

    def interrupt_callback(event):
        interrupt_response["response"] = event.interrupt("test_name", "test reason")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_callback)

    mock_model.mock_stream.return_value = agenerator(
        [
            {"contentBlockStart": {"start": {"text": ""}}},
            {"contentBlockDelta": {"delta": {"text": "resumed"}}},
            {"contentBlockStop": {}},
        ]
    )

    prompt = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "test response",
            }
        }
    ]
    agent(prompt)

    tru_result_message = agent.messages[-2]
    exp_result_message = {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "t1",
                    "status": "success",
                    "content": [{"text": "test input"}],
                },
            },
        ],
        "tracking_id": unittest.mock.ANY,
    }
    assert tru_result_message == exp_result_message

    tru_response = interrupt_response["response"]
    exp_response = "test response"
    assert tru_response == exp_response

    tru_state = agent._interrupt_state.to_dict()
    exp_state = {
        "activated": False,
        "context": {},
        "interrupts": {},
    }
    assert tru_state == exp_state


def test_agent__call__resume_interrupt_invalid_prompt():
    agent = Agent()
    agent._interrupt_state.activated = True

    exp_message = r"prompt_type=<class 'str'> \| must resume from interrupt with list of interruptResponse's"
    with pytest.raises(TypeError, match=exp_message):
        agent("invalid")


def test_agent__call__resume_interrupt_invalid_content():
    agent = Agent()
    agent._interrupt_state.activated = True

    exp_message = r"content_types=<\['text'\]> \| must resume from interrupt with list of interruptResponse's"
    with pytest.raises(TypeError, match=exp_message):
        agent([{"text": "invalid"}])


def test_agent__call__resume_interrupt_invalid_id():
    agent = Agent()
    agent._interrupt_state.activated = True

    exp_message = r"interrupt_id=<invalid> \| no interrupt found"
    with pytest.raises(KeyError, match=exp_message):
        agent([{"interruptResponse": {"interruptId": "invalid", "response": None}}])


def test_agent__call__resume_interrupt_not_activated():
    """Passing interrupt responses to an agent not in interrupt state should raise a clear error."""
    agent = Agent()

    exp_message = r"Received interrupt responses but agent is not in interrupt state"
    with pytest.raises(ValueError, match=exp_message):
        agent([{"interruptResponse": {"interruptId": "test-id", "response": "yes"}}])


def test_agent_structured_output_interrupt(user):
    agent = Agent()
    agent._interrupt_state.activated = True

    exp_message = r"cannot call structured output during interrupt"
    with pytest.raises(RuntimeError, match=exp_message):
        agent.structured_output(type(user), "invalid")


def test_latest_message_tool_use_skips_model_invoke(tool_decorated):
    mock_model = MockedModelProvider([{"role": "assistant", "content": [{"text": "I see the tool result"}]}])

    messages: Messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "123", "name": "tool_decorated", "input": {"random_string": "Hello"}}}
            ],
        }
    ]
    agent = Agent(model=mock_model, tools=[tool_decorated], messages=messages)

    agent()

    assert mock_model.index == 1
    assert len(agent.messages) == 3
    assert agent.messages[1]["content"][0]["toolResult"]["content"][0]["text"] == "Hello"
    assert agent.messages[2]["content"][0]["text"] == "I see the tool result"


def test_agent_del_before_tool_registry_set():
    """Test that Agent.__del__ doesn't fail if called before tool_registry is set."""
    agent = Agent()
    del agent.tool_registry
    agent.__del__()  # Should not raise


def test_agent__call__invalid_tool_name():
    @strands.tool
    def shell(command: str):
        pass

    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "tool_use_id",
                            "name": "invalid tool",
                            "input": "{}",
                        }
                    }
                ],
            },
            {"role": "assistant", "content": [{"text": "I invoked a tool!"}]},
        ]
    )

    agent = Agent(tools=[shell], model=model)
    result = agent("Test")

    # Ensure the stop_reason is
    assert result.stop_reason == "end_turn"

    # Assert that there exists a message with a toolResponse
    assert agent.messages[-2] == {
        "content": [
            {
                "toolResult": {
                    "content": [{"text": "Error: tool_name=<invalid tool> | invalid tool name pattern"}],
                    "status": "error",
                    "toolUseId": "tool_use_id",
                }
            }
        ],
        "role": "user",
        "tracking_id": unittest.mock.ANY,
    }

    # And that it continued to the LLM call
    assert agent.messages[-1] == {
        "content": [{"text": "I invoked a tool!"}],
        "role": "assistant",
        "metadata": unittest.mock.ANY,
        "tracking_id": unittest.mock.ANY,
    }


def test_agent_string_system_prompt():
    """Test initialization with string system prompt."""
    system_prompt = "You are a helpful assistant."
    agent = Agent(system_prompt=system_prompt)

    assert agent.system_prompt == system_prompt
    assert agent._system_prompt_content == [{"text": system_prompt}]


def test_agent_single_text_block_system_prompt():
    """Test initialization with single text SystemContentBlock."""
    text = "You are a helpful assistant."
    system_prompt_content = [{"text": text}]
    agent = Agent(system_prompt=system_prompt_content)

    assert agent.system_prompt == text
    assert agent._system_prompt_content == system_prompt_content


def test_agent_multiple_blocks_system_prompt():
    """Test initialization with multiple SystemContentBlocks."""
    system_prompt_content = [
        {"text": "You are a helpful assistant."},
        {"cachePoint": {"type": "default"}},
        {"text": "Additional instructions."},
    ]
    agent = Agent(system_prompt=system_prompt_content)

    assert agent.system_prompt == "You are a helpful assistant.\nAdditional instructions."
    assert agent._system_prompt_content == system_prompt_content


def test_agent_single_non_text_block_system_prompt():
    """Test initialization with single non-text SystemContentBlock."""
    system_prompt_content = [{"cachePoint": {"type": "default"}}]
    agent = Agent(system_prompt=system_prompt_content)

    assert agent.system_prompt is None
    assert agent._system_prompt_content == system_prompt_content


def test_agent_none_system_prompt():
    """Test initialization with None system prompt."""
    agent = Agent(system_prompt=None)

    assert agent.system_prompt is None
    assert agent._system_prompt_content is None


def test_agent_empty_list_system_prompt():
    """Test initialization with empty list system prompt."""
    agent = Agent(system_prompt=[])

    assert agent.system_prompt is None
    assert agent._system_prompt_content == []


def test_agent_backwards_compatibility_string_access():
    """Test that string system prompts maintain backwards compatibility."""
    system_prompt = "You are a helpful assistant."
    agent = Agent(system_prompt=system_prompt)

    # Should be able to access as string for backwards compatibility
    assert agent.system_prompt == system_prompt


def test_agent_backwards_compatibility_single_text_block():
    """Test that single text blocks maintain backwards compatibility."""
    text = "You are a helpful assistant."
    system_prompt_content = [{"text": text}]
    agent = Agent(system_prompt=system_prompt_content)

    # Should extract text for backwards compatibility
    assert agent.system_prompt == text


@pytest.mark.parametrize(
    "content, expected",
    [
        # Single toolResult block - preserves structure, redacts content
        (
            [{"toolResult": {"toolUseId": "123", "content": [{"text": "original result"}], "status": "success"}}],
            [{"toolResult": {"toolUseId": "123", "content": [{"text": "REDACTED"}], "status": "success"}}],
        ),
        # Multiple toolResult blocks - preserves all, redacts each content
        (
            [
                {"toolResult": {"toolUseId": "123", "content": [{"text": "result1"}], "status": "success"}},
                {"toolResult": {"toolUseId": "456", "content": [{"text": "result2"}], "status": "error"}},
            ],
            [
                {"toolResult": {"toolUseId": "123", "content": [{"text": "REDACTED"}], "status": "success"}},
                {"toolResult": {"toolUseId": "456", "content": [{"text": "REDACTED"}], "status": "error"}},
            ],
        ),
        # Text only content - replaces with single text block
        (
            [{"text": "sensitive data"}],
            [{"text": "REDACTED"}],
        ),
        # Mixed content with toolResult - keeps only toolResult blocks
        # (This should not actually happen, toolResult is never mixed with other content)
        (
            [
                {"text": "some text"},
                {"toolResult": {"toolUseId": "789", "content": [{"text": "tool output"}], "status": "success"}},
                {"image": {"format": "png", "source": {"bytes": b"fake_data"}}},
            ],
            [{"toolResult": {"toolUseId": "789", "content": [{"text": "REDACTED"}], "status": "success"}}],
        ),
        # Empty content - returns single text block
        (
            [],
            [{"text": "REDACTED"}],
        ),
    ],
    ids=[
        "single_tool_result",
        "multiple_tool_results",
        "text_only",
        "mixed_content_with_tool_result",
        "empty_content",
    ],
)
def test_redact_user_content(content, expected):
    """Test _redact_user_content function with various content types."""
    agent = Agent()
    result = agent._redact_user_content(content, "REDACTED")
    assert result == expected


def test_agent_fixes_orphaned_tool_use_on_new_prompt(mock_model, agenerator):
    """Test that agent adds toolResult for orphaned toolUse when called with new prompt."""
    mock_model.mock_stream.return_value = agenerator(
        [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {"text": ""}}},
            {"contentBlockDelta": {"delta": {"text": "Fixed!"}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )

    # Start with orphaned toolUse message
    messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "orphaned-123", "name": "tool_decorated", "input": {"random_string": "test"}}}
            ],
        }
    ]

    agent = Agent(model=mock_model, messages=messages)

    # Call with new prompt should fix orphaned toolUse
    agent("Continue conversation")

    # Should have added toolResult message
    assert len(agent.messages) >= 3
    assert agent.messages[1] == {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "orphaned-123",
                    "status": "error",
                    "content": [{"text": "Tool was interrupted."}],
                }
            }
        ],
        "tracking_id": unittest.mock.ANY,
    }


def test_agent_fixes_multiple_orphaned_tool_uses(mock_model, agenerator):
    """Test that agent handles multiple orphaned toolUse messages."""
    mock_model.mock_stream.return_value = agenerator(
        [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {"text": ""}}},
            {"contentBlockDelta": {"delta": {"text": "Fixed multiple!"}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )

    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "orphaned-123",
                        "name": "tool_decorated",
                        "input": {"random_string": "test1"},
                    }
                },
                {
                    "toolUse": {
                        "toolUseId": "orphaned-456",
                        "name": "tool_decorated",
                        "input": {"random_string": "test2"},
                    }
                },
            ],
        }
    ]

    agent = Agent(model=mock_model, messages=messages)
    agent("Continue")

    # Should have toolResult for both toolUse IDs
    assert agent.messages[1] == {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "orphaned-123",
                    "status": "error",
                    "content": [{"text": "Tool was interrupted."}],
                }
            },
            {
                "toolResult": {
                    "toolUseId": "orphaned-456",
                    "status": "error",
                    "content": [{"text": "Tool was interrupted."}],
                }
            },
        ],
        "tracking_id": unittest.mock.ANY,
    }


def test_agent_skips_fix_for_valid_conversation(mock_model, agenerator):
    """Test that agent doesn't modify valid toolUse/toolResult pairs."""
    mock_model.mock_stream.return_value = agenerator(
        [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {"text": ""}}},
            {"contentBlockDelta": {"delta": {"text": "No fix needed!"}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
    )

    # Valid conversation with toolUse followed by toolResult
    messages = [
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "valid-123", "name": "tool_decorated", "input": {"random_string": "test"}}}
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "valid-123", "status": "success", "content": [{"text": "result"}]}}
            ],
        },
    ]

    agent = Agent(model=mock_model, messages=messages)
    original_length = len(agent.messages)

    agent("Continue")

    # Should not have added any toolResult messages
    # Only the new user message and assistant response should be added
    assert len(agent.messages) == original_length + 2


# ============================================================================
# Concurrency Exception Tests
# ============================================================================


def test_agent_concurrent_call_raises_exception():
    """Test that concurrent __call__() calls raise ConcurrencyException."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "world"}]},
        ]
    )
    agent = Agent(model=model, concurrent_invocation_mode="throw")

    results = []
    errors = []

    def invoke():
        try:
            result = agent("test")
            results.append(result)
        except ConcurrencyException as e:
            errors.append(e)

    # Start first thread and wait for it to begin streaming
    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()  # Wait until first thread is in the model.stream()

    # Start second thread while first is still running
    t2 = threading.Thread(target=invoke)
    t2.start()

    # Give second thread time to attempt invocation and fail
    t2.join(timeout=1.0)

    # Now let first thread complete
    model.proceed_event.set()
    t1.join()
    t2.join()

    # One should succeed, one should raise ConcurrencyException
    assert len(results) == 1, f"Expected 1 success, got {len(results)}"
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}"
    assert "concurrent" in str(errors[0]).lower() and "invocation" in str(errors[0]).lower()


def test_agent_concurrent_structured_output_raises_exception():
    """Test that concurrent structured_output() calls raise ConcurrencyException.

    Note: This test validates that the sync invocation path is protected.
    The concurrent __call__() test already validates the core functionality.
    """
    # Events for synchronization
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "response1"}]},
            {"role": "assistant", "content": [{"text": "response2"}]},
        ],
    )
    agent = Agent(model=model, concurrent_invocation_mode="throw")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            result = agent("test")
            with lock:
                results.append(result)
        except ConcurrencyException as e:
            with lock:
                errors.append(e)

    # Start first thread and wait for it to begin streaming
    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()  # Wait until first thread is in the model.stream()

    # Start second thread while first is still running
    t2 = threading.Thread(target=invoke)
    t2.start()

    # Give second thread time to attempt invocation and fail
    t2.join(timeout=1.0)

    # Now let first thread complete
    model.proceed_event.set()
    t1.join()
    t2.join()

    # One should succeed, one should raise ConcurrencyException
    assert len(results) == 1, f"Expected 1 success, got {len(results)}"
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}"
    assert "concurrent" in str(errors[0]).lower() and "invocation" in str(errors[0]).lower()


def test_agent_concurrent_call_succeeds_with_unsafe_reentrant_mode():
    """Test that concurrent __call__() calls succeed when concurrent_invocation_mode is 'unsafe_reentrant'."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "world"}]},
        ]
    )
    agent = Agent(model=model, concurrent_invocation_mode="unsafe_reentrant")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            result = agent("test")
            with lock:
                results.append(result)
        except ConcurrencyException as e:
            with lock:
                errors.append(e)

    # Start first thread and wait for it to begin streaming
    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()  # Wait until first thread is in the model.stream()

    # Start second thread while first is still running
    t2 = threading.Thread(target=invoke)
    t2.start()

    # Let both threads proceed
    model.proceed_event.set()
    t1.join()
    t2.join()

    # Both should succeed, no ConcurrencyException raised
    assert len(errors) == 0, f"Expected 0 errors, got {len(errors)}: {errors}"
    assert len(results) == 2, f"Expected 2 successes, got {len(results)}"


def test_agent_concurrent_invocation_mode_default_is_throw():
    """Test that the default concurrent_invocation_mode is 'throw'."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "hello"}]}])
    agent = Agent(model=model)

    # Verify the default mode
    assert agent.concurrent_invocation_mode == "throw"


def test_agent_concurrent_invocation_mode_stores_value():
    """Test that concurrent_invocation_mode is stored correctly as instance variable."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "hello"}]}])

    agent_throw = Agent(model=model, concurrent_invocation_mode="throw")
    assert agent_throw.concurrent_invocation_mode == "throw"

    agent_reentrant = Agent(model=model, concurrent_invocation_mode="unsafe_reentrant")
    assert agent_reentrant.concurrent_invocation_mode == "unsafe_reentrant"


def test_agent_concurrent_invocation_mode_accepts_enum():
    """Test that concurrent_invocation_mode accepts enum values as well as strings."""

    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "hello"}]}])

    # Using enum values
    agent_throw = Agent(model=model, concurrent_invocation_mode=ConcurrentInvocationMode.THROW)
    assert agent_throw.concurrent_invocation_mode == "throw"
    assert agent_throw.concurrent_invocation_mode == ConcurrentInvocationMode.THROW

    agent_reentrant = Agent(model=model, concurrent_invocation_mode=ConcurrentInvocationMode.UNSAFE_REENTRANT)
    assert agent_reentrant.concurrent_invocation_mode == "unsafe_reentrant"
    assert agent_reentrant.concurrent_invocation_mode == ConcurrentInvocationMode.UNSAFE_REENTRANT


@pytest.mark.asyncio
async def test_agent_sequential_invocations_work():
    """Test that sequential invocations work correctly after lock is released."""
    model = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "response1"}]},
            {"role": "assistant", "content": [{"text": "response2"}]},
            {"role": "assistant", "content": [{"text": "response3"}]},
        ]
    )
    agent = Agent(model=model)

    # All sequential calls should succeed
    result1 = await agent.invoke_async("test1")
    assert result1.message["content"][0]["text"] == "response1"

    result2 = await agent.invoke_async("test2")
    assert result2.message["content"][0]["text"] == "response2"

    result3 = await agent.invoke_async("test3")
    assert result3.message["content"][0]["text"] == "response3"


@pytest.mark.asyncio
async def test_agent_lock_released_on_exception():
    """Test that lock is released when an exception occurs during invocation."""

    # Create a mock model that raises an explicit error
    mock_model = unittest.mock.Mock()

    async def failing_stream(*args, **kwargs):
        raise RuntimeError("Simulated model failure")
        yield  # Make this an async generator

    mock_model.stream = failing_stream

    agent = Agent(model=mock_model)

    # First call will fail due to the simulated error
    with pytest.raises(RuntimeError, match="Simulated model failure"):
        await agent.invoke_async("test")

    # Lock should be released, so this should not raise ConcurrencyException
    # It will still raise RuntimeError, but that's expected
    with pytest.raises(RuntimeError, match="Simulated model failure"):
        await agent.invoke_async("test")


def test_agent_direct_tool_call_during_invocation_raises_exception(tool_decorated):
    """Test that direct tool call during agent invocation raises ConcurrencyException."""

    tool_calls = []

    @strands.tool
    def tool_to_invoke():
        tool_calls.append("tool_to_invoke")
        return "called"

    @strands.tool(context=True)
    def agent_tool(tool_context: ToolContext) -> str:
        tool_context.agent.tool.tool_to_invoke(record_direct_tool_call=True)
        return "tool result"

    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "test-123",
                            "name": "agent_tool",
                            "input": {},
                        }
                    }
                ],
            },
            {"role": "assistant", "content": [{"text": "Done"}]},
        ]
    )
    agent = Agent(model=model, tools=[agent_tool, tool_to_invoke])
    agent("Hi")

    # Tool call should have not succeeded
    assert len(tool_calls) == 0

    assert agent.messages[-2] == {
        "content": [
            {
                "toolResult": {
                    "content": [
                        {
                            "text": "Error: ConcurrencyException - Direct tool call cannot be made while the agent is "
                            "in the middle of an invocation. Set record_direct_tool_call=False to allow direct tool "
                            "calls during agent invocation."
                        }
                    ],
                    "status": "error",
                    "toolUseId": "test-123",
                }
            }
        ],
        "role": "user",
        "tracking_id": unittest.mock.ANY,
    }


def test_agent_direct_tool_call_during_invocation_succeeds_with_record_false(tool_decorated):
    """Test that direct tool call during agent invocation succeeds when record_direct_tool_call=False."""
    tool_calls = []

    @strands.tool
    def tool_to_invoke():
        tool_calls.append("tool_to_invoke")
        return "called"

    @strands.tool(context=True)
    def agent_tool(tool_context: ToolContext) -> str:
        tool_context.agent.tool.tool_to_invoke(record_direct_tool_call=False)
        return "tool result"

    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "test-123",
                            "name": "agent_tool",
                            "input": {},
                        }
                    }
                ],
            },
            {"role": "assistant", "content": [{"text": "Done"}]},
        ]
    )
    agent = Agent(model=model, tools=[agent_tool, tool_to_invoke])
    agent("Hi")

    # Tool call should have succeeded
    assert len(tool_calls) == 1

    assert agent.messages[-2] == {
        "content": [
            {
                "toolResult": {
                    "content": [{"text": "tool result"}],
                    "status": "success",
                    "toolUseId": "test-123",
                }
            }
        ],
        "role": "user",
        "tracking_id": unittest.mock.ANY,
    }


def test_agent_add_hook_registers_callback():
    """Test that add_hook registers a callback with the hooks registry."""
    agent = Agent(model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]))
    callback = unittest.mock.Mock()

    agent.add_hook(callback, BeforeModelCallEvent)

    # Verify callback was registered by checking it gets invoked
    agent("test prompt")
    callback.assert_called_once()
    # Verify it was called with the correct event type
    call_args = callback.call_args[0]
    assert isinstance(call_args[0], BeforeModelCallEvent)


def test_agent_add_hook_delegates_to_hooks_add_callback():
    """Test that add_hook delegates to self.hooks.add_callback."""
    agent = Agent(model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]))
    callback = unittest.mock.Mock()

    # Spy on the hooks.add_callback method
    with unittest.mock.patch.object(agent.hooks, "add_callback") as mock_add_callback:
        agent.add_hook(callback, BeforeInvocationEvent)
        mock_add_callback.assert_called_once_with(BeforeInvocationEvent, callback, order=0)


@pytest.mark.asyncio
async def test_agent_add_hook_works_with_async_callback():
    """Test that add_hook works with async callbacks."""

    agent = Agent(model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]))
    async_callback = unittest.mock.AsyncMock()

    agent.add_hook(async_callback, BeforeModelCallEvent)

    # Use stream_async to invoke the agent with async support
    _ = [event async for event in agent.stream_async("test prompt")]
    async_callback.assert_called_once()
    # Verify it was called with the correct event type
    call_args = async_callback.call_args[0]
    assert isinstance(call_args[0], BeforeModelCallEvent)


def test_agent_add_hook_infers_event_type_from_callback():
    """Test that add_hook infers event type from callback type hint."""
    agent = Agent(model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]))
    callback_invoked = []

    def typed_callback(event: BeforeModelCallEvent) -> None:
        callback_invoked.append(event)

    agent.add_hook(typed_callback)
    agent("test prompt")

    assert len(callback_invoked) == 1
    assert isinstance(callback_invoked[0], BeforeModelCallEvent)


def test_agent_add_hook_raises_error_when_no_type_hint():
    """Test that add_hook raises error when event type cannot be inferred."""
    agent = Agent(model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]))

    def untyped_callback(event):
        pass

    with pytest.raises(ValueError, match="cannot infer event type"):
        agent.add_hook(untyped_callback)


def test_agent_plugins_sync_initialization():
    """Test that plugins with sync init_agent are initialized correctly."""
    plugin_mock = unittest.mock.Mock()
    plugin_mock.name = "test-plugin"
    plugin_mock.hooks = []
    plugin_mock.tools = []
    plugin_mock.init_agent = unittest.mock.Mock()

    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        plugins=[plugin_mock],
    )

    plugin_mock.init_agent.assert_called_once_with(agent)


def test_agent_plugins_async_initialization():
    """Test that plugins with async init_agent are initialized correctly."""
    plugin_mock = unittest.mock.Mock()
    plugin_mock.name = "async-plugin"
    plugin_mock.hooks = []
    plugin_mock.tools = []
    plugin_mock.init_agent = unittest.mock.AsyncMock()

    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        plugins=[plugin_mock],
    )

    plugin_mock.init_agent.assert_called_once_with(agent)


def test_agent_plugins_multiple_in_order():
    """Test that multiple plugins are initialized in order."""
    call_order = []

    plugin1 = unittest.mock.Mock()
    plugin1.name = "plugin1"
    plugin1.hooks = []
    plugin1.tools = []
    plugin1.init_agent = unittest.mock.Mock(side_effect=lambda agent: call_order.append("plugin1"))

    plugin2 = unittest.mock.Mock()
    plugin2.name = "plugin2"
    plugin2.hooks = []
    plugin2.tools = []
    plugin2.init_agent = unittest.mock.Mock(side_effect=lambda agent: call_order.append("plugin2"))

    Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        plugins=[plugin1, plugin2],
    )

    assert call_order == ["plugin1", "plugin2"]


def test_agent_plugins_can_register_hooks():
    """Test that plugins can register hooks during initialization."""
    hook_called = []

    class TestPlugin(Plugin):
        name = "hook-plugin"

        def init_agent(self, agent):
            def hook_callback(event: BeforeModelCallEvent):
                hook_called.append(True)

            agent.add_hook(hook_callback)

    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        plugins=[TestPlugin()],
    )

    agent("test")

    assert len(hook_called) == 1


class _SearchOnlyStore:
    """Minimal read-only memory store for exercising Agent's memory_manager wiring."""

    name = "notes"
    description = None
    max_search_results = None
    writable = False
    extraction = None

    async def search(self, query, options=None):
        return []


def test_agent_memory_manager_instance_registers_tools_and_is_exposed():
    memory_manager = MemoryManager(stores=[_SearchOnlyStore()])
    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        memory_manager=memory_manager,
    )

    assert agent.memory_manager is memory_manager
    assert "search_memory" in agent.tool_names


def test_agent_memory_manager_config_is_wrapped():
    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        memory_manager=MemoryManagerConfig(stores=[_SearchOnlyStore()]),
    )

    assert isinstance(agent.memory_manager, MemoryManager)
    assert "search_memory" in agent.tool_names


def test_agent_memory_manager_defaults_to_none():
    agent = Agent(model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]))

    assert agent.memory_manager is None


def test_agent_memory_manager_passed_via_both_paths_raises():
    memory_manager = MemoryManager(stores=[_SearchOnlyStore()])
    with pytest.raises(ValueError, match="pass it through the memory_manager parameter instead"):
        Agent(
            model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
            plugins=[memory_manager],
            memory_manager=memory_manager,
        )


def test_agent_sync_call_flushes_memory_manager():
    memory_manager = MemoryManager(stores=[_SearchOnlyStore()])
    memory_manager.flush = unittest.mock.AsyncMock()
    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        memory_manager=memory_manager,
    )

    agent("test")

    memory_manager.flush.assert_awaited_once()


@pytest.mark.asyncio
async def test_agent_async_invoke_does_not_flush_memory_manager():
    memory_manager = MemoryManager(stores=[_SearchOnlyStore()])
    memory_manager.flush = unittest.mock.AsyncMock()
    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "response"}]}]),
        memory_manager=memory_manager,
    )

    await agent.invoke_async("test")

    memory_manager.flush.assert_not_awaited()


def test_as_tool_returns_agent_tool():
    """Test that as_tool returns an _AgentAsTool wrapping the agent."""
    agent = Agent(name="researcher", description="Finds information")
    tool = agent.as_tool()

    assert isinstance(tool, _AgentAsTool)
    assert tool.agent is agent


def test_as_tool_defaults_name_from_agent():
    """Test that as_tool defaults the tool name to the agent's name."""
    agent = Agent(name="researcher")
    tool = agent.as_tool()

    assert tool.tool_name == "researcher"


def test_as_tool_defaults_description_from_agent():
    """Test that as_tool defaults the description to the agent's description."""
    agent = Agent(name="researcher", description="Finds information")
    tool = agent.as_tool()

    assert tool.tool_spec["description"] == "Finds information"


def test_as_tool_custom_name():
    """Test that as_tool accepts a custom name."""
    agent = Agent(name="researcher")
    tool = agent.as_tool(name="custom_name")

    assert tool.tool_name == "custom_name"


def test_as_tool_custom_description():
    """Test that as_tool accepts a custom description."""
    agent = Agent(name="researcher", description="Original")
    tool = agent.as_tool(description="Custom description")

    assert tool.tool_spec["description"] == "Custom description"


def test_as_tool_defaults_description_when_agent_has_none():
    """Test that as_tool generates a default description when agent has none."""
    agent = Agent(name="researcher")
    tool = agent.as_tool()

    assert tool.tool_spec["description"] == "Use the researcher agent as a tool by providing a natural language input"


def test_idempotency_duplicate_waits_and_returns_same_result():
    """Test that a duplicate call with the same idempotency_token waits and returns the same result."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
        ]
    )
    # Record result callbacks to verify the duplicate path mirrors the primary's
    # callback_handler(result=...) call, not just the returned/yielded result.
    result_callbacks = []
    cb_lock = threading.Lock()

    def callback_handler(**kwargs):
        if "result" in kwargs:
            with cb_lock:
                result_callbacks.append(kwargs["result"])

    agent = IdempotencyTestAgent(model=model, concurrent_invocation_mode="throw", callback_handler=callback_handler)

    results = []
    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            result = agent("test", idempotency_token="abc-123")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()

    t2 = threading.Thread(target=invoke)
    t2.start()
    agent.duplicate_detected.wait()

    model.proceed_event.set()
    t1.join()
    t2.join()

    assert len(errors) == 0, f"Expected 0 errors, got {len(errors)}: {errors}"
    assert len(results) == 2, f"Expected 2 results, got {len(results)}"
    assert str(results[0]) == str(results[1])
    # Both the primary and the deduplicated duplicate must each fire a result callback.
    assert len(result_callbacks) == 2, f"Expected 2 result callbacks, got {len(result_callbacks)}"
    assert str(result_callbacks[0]) == str(result_callbacks[1])


def test_idempotency_original_fails_duplicate_gets_same_error():
    """Test that when the original invocation fails, the duplicate receives the same exception."""
    model = SyncEventFailingModel()
    agent = IdempotencyTestAgent(model=model, concurrent_invocation_mode="throw")

    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            agent("test", idempotency_token="abc-123")
        except Exception as e:
            with lock:
                errors.append(e)

    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()

    t2 = threading.Thread(target=invoke)
    t2.start()
    agent.duplicate_detected.wait()

    model.proceed_event.set()
    t1.join()
    t2.join()

    assert len(errors) == 2, f"Expected 2 errors, got {len(errors)}"
    assert all(isinstance(e, RuntimeError) for e in errors)
    assert all("Simulated model failure" in str(e) for e in errors)


def test_idempotency_different_token_raises_concurrency_exception():
    """Test that a different idempotency_token while another is inflight raises ConcurrencyException."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "world"}]},
        ]
    )
    agent = Agent(model=model, concurrent_invocation_mode="throw")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke_abc():
        try:
            result = agent("test", idempotency_token="abc")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    def invoke_def():
        try:
            result = agent("test", idempotency_token="def")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    t1 = threading.Thread(target=invoke_abc)
    t1.start()
    model.started_event.wait()

    t2 = threading.Thread(target=invoke_def)
    t2.start()
    t2.join(timeout=1.0)

    model.proceed_event.set()
    t1.join()
    t2.join()

    assert len(results) == 1, f"Expected 1 result, got {len(results)}"
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}"
    assert isinstance(errors[0], ConcurrencyException)


def test_idempotency_no_token_falls_back_to_throw():
    """Test that a call without idempotency_token still gets ConcurrencyException in THROW mode."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "world"}]},
        ]
    )
    agent = Agent(model=model, concurrent_invocation_mode="throw")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke_with_token():
        try:
            result = agent("test", idempotency_token="abc")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    def invoke_without_token():
        try:
            result = agent("test")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    t1 = threading.Thread(target=invoke_with_token)
    t1.start()
    model.started_event.wait()

    t2 = threading.Thread(target=invoke_without_token)
    t2.start()
    t2.join(timeout=1.0)

    model.proceed_event.set()
    t1.join()
    t2.join()

    assert len(results) == 1, f"Expected 1 result, got {len(results)}"
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}"
    assert isinstance(errors[0], ConcurrencyException)


def test_idempotency_ignored_in_unsafe_reentrant():
    """Test that idempotency_token has no effect in UNSAFE_REENTRANT mode."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "world"}]},
        ]
    )
    agent = Agent(model=model, concurrent_invocation_mode="unsafe_reentrant")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            result = agent("test", idempotency_token="abc")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()

    t2 = threading.Thread(target=invoke)
    t2.start()

    model.proceed_event.set()
    t1.join()
    t2.join()

    assert len(errors) == 0, f"Expected 0 errors, got {len(errors)}: {errors}"
    assert len(results) == 2, f"Expected 2 results, got {len(results)}"


def test_idempotency_cleanup_after_completion():
    """Test that after completion, the same token is treated as a fresh request."""
    model = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "response1"}]},
            {"role": "assistant", "content": [{"text": "response2"}]},
        ]
    )
    agent = Agent(model=model, concurrent_invocation_mode="throw")

    result1 = agent("test", idempotency_token="abc")
    assert str(result1).strip() == "response1"

    result2 = agent("test", idempotency_token="abc")
    assert str(result2).strip() == "response2"

    assert str(result1) != str(result2)


def test_idempotency_with_prompt_as_token():
    """Test that the prompt itself can be used as the idempotency_token."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
        ]
    )
    agent = IdempotencyTestAgent(model=model, concurrent_invocation_mode="throw")

    prompt = "What's the weather?"
    results = []
    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            result = agent(prompt, idempotency_token=prompt)
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()

    t2 = threading.Thread(target=invoke)
    t2.start()
    agent.duplicate_detected.wait()

    model.proceed_event.set()
    t1.join()
    t2.join()

    assert len(errors) == 0, f"Expected 0 errors, got {len(errors)}: {errors}"
    assert len(results) == 2, f"Expected 2 results, got {len(results)}"
    assert str(results[0]) == str(results[1])


def test_idempotency_no_deadlock_on_competing_token():
    """A 3rd thread with a different token must not prevent a waiting duplicate from waking up.

    T1 runs with token "abc" → T2 (same token) waits as duplicate → T3 arrives with token "def"
    and gets ConcurrencyException. T1 then completes and T2 must receive the result, not hang.
    """
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
            {"role": "assistant", "content": [{"text": "world"}]},
        ]
    )
    agent = IdempotencyTestAgent(model=model, concurrent_invocation_mode="throw")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke_abc():
        try:
            result = agent("test", idempotency_token="abc")
            with lock:
                results.append(("abc", result))
        except Exception as e:
            with lock:
                errors.append(e)

    def invoke_def():
        try:
            result = agent("test", idempotency_token="def")
            with lock:
                results.append(("def", result))
        except Exception as e:
            with lock:
                errors.append(e)

    # T1 starts and pauses inside the model
    t1 = threading.Thread(target=invoke_abc)
    t1.start()
    model.started_event.wait()

    # T2 detects duplicate and waits
    t2 = threading.Thread(target=invoke_abc)
    t2.start()
    agent.duplicate_detected.wait()

    # T3 arrives with a different token - must get ConcurrencyException, not corrupt T1's state
    t3 = threading.Thread(target=invoke_def)
    t3.start()
    t3.join(timeout=2.0)
    assert not t3.is_alive(), "T3 should have returned quickly with ConcurrencyException"

    # Unblock T1; T2 must wake up (not hang)
    model.proceed_event.set()
    t1.join(timeout=5.0)
    t2.join(timeout=5.0)

    assert not t1.is_alive(), "T1 hung - possible deadlock"
    assert not t2.is_alive(), "T2 hung - deadlock: waiting duplicate never woke up"

    abc_results = [r for name, r in results if name == "abc"]
    assert len(abc_results) == 2, f"Expected T1 and T2 both to succeed, got results={results} errors={errors}"
    assert str(abc_results[0]) == str(abc_results[1])

    concurrency_errors = [e for e in errors if isinstance(e, ConcurrencyException)]
    assert len(concurrency_errors) == 1, f"Expected exactly 1 ConcurrencyException for T3, got {errors}"


def test_idempotency_multiple_duplicates_all_wake_up():
    """Test that multiple duplicates waiting on the same token all receive the result."""
    model = SyncEventMockedModel(
        [
            {"role": "assistant", "content": [{"text": "hello"}]},
        ]
    )
    agent = IdempotencyTestAgent(model=model, concurrent_invocation_mode="throw")

    results = []
    errors = []
    lock = threading.Lock()

    def invoke():
        try:
            result = agent("test", idempotency_token="abc")
            with lock:
                results.append(result)
        except Exception as e:
            with lock:
                errors.append(e)

    # T1 is the primary
    t1 = threading.Thread(target=invoke)
    t1.start()
    model.started_event.wait()

    # T2 and T3 are both duplicates waiting on the same token
    t2 = threading.Thread(target=invoke)
    t2.start()
    agent.duplicate_detected.wait()
    agent.duplicate_detected.clear()

    t3 = threading.Thread(target=invoke)
    t3.start()
    agent.duplicate_detected.wait()

    model.proceed_event.set()
    t1.join()
    t2.join()
    t3.join()

    assert len(errors) == 0, f"Expected 0 errors, got {len(errors)}: {errors}"
    assert len(results) == 3, f"Expected 3 results (T1, T2, T3), got {len(results)}"
    assert str(results[0]) == str(results[1]) == str(results[2])


def test_idempotency_cleanup_after_failure():
    """Test that after a failure, the same token is treated as a fresh request."""
    fail_model = SyncEventFailingModel()
    agent = Agent(model=fail_model, concurrent_invocation_mode="throw")

    # First call fails
    with pytest.raises(RuntimeError, match="Simulated model failure"):
        fail_model.proceed_event.set()
        agent("test", idempotency_token="abc")

    # Second call with the same token should run fresh, not be treated as a duplicate
    success_model = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "recovered"}]},
        ]
    )
    agent.model = success_model
    result = agent("test", idempotency_token="abc")
    assert str(result).strip() == "recovered"


# ============================================================================
# Checkpointing Tests
# ============================================================================


def test_agent_checkpointing_defaults_to_false() -> None:
    agent = Agent()
    assert agent._checkpointing is False
    assert agent._checkpoint is None


def test_agent_checkpointing_flag_stored() -> None:
    agent = Agent(checkpointing=True)
    assert agent._checkpointing is True
    assert agent._checkpoint is None


@pytest.mark.asyncio
async def test_checkpoint_cycle_index_resets_between_invocations() -> None:
    """A stale cycle index from a prior invocation does not leak into the next."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "done"}]}])
    agent = Agent(model=model, checkpointing=True)

    # Simulate state left over from a prior checkpointing run.
    agent._checkpoint_cycle_index = 5
    agent._checkpoint_resume_position = "after_tools"

    await agent.invoke_async("hello")

    assert agent._checkpoint_cycle_index == 0
    assert agent._checkpoint_resume_position is None


@pytest.mark.asyncio
async def test_checkpoint_resume_without_checkpointing_flag_raises_value_error() -> None:
    agent = Agent(checkpointing=False)
    prompt = {"checkpointResume": {"checkpoint": {}}}
    with pytest.raises(ValueError, match="checkpointing=True"):
        await agent.invoke_async(prompt)


@pytest.mark.asyncio
async def test_checkpoint_resume_missing_checkpoint_key_raises_key_error() -> None:
    agent = Agent(checkpointing=True)
    prompt = {"checkpointResume": {}}
    with pytest.raises(KeyError, match="checkpoint"):
        await agent.invoke_async(prompt)


@pytest.mark.asyncio
async def test_checkpoint_resume_schema_mismatch_raises_checkpoint_exception() -> None:
    agent = Agent(checkpointing=True)
    prompt = {"checkpointResume": {"checkpoint": {"schema_version": "0.1", "position": "after_model"}}}
    with pytest.raises(CheckpointException, match="schema version"):
        await agent.invoke_async(prompt)
