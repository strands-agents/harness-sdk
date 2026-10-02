from unittest.mock import ANY, AsyncMock, MagicMock, Mock, patch

import pytest
from pydantic import BaseModel

import strands
from strands import Agent
from strands.hooks import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    AfterToolCallEvent,
    AgentInitializedEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    MessageAddedEvent,
)
from strands.interrupt import Interrupt, InterruptException
from strands.types.content import Messages
from strands.types.exceptions import ModelThrottledException
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.mock_hook_provider import MockHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def hook_provider():
    return MockHookProvider(
        [
            AgentInitializedEvent,
            BeforeInvocationEvent,
            AfterInvocationEvent,
            AfterToolCallEvent,
            BeforeToolCallEvent,
            BeforeModelCallEvent,
            AfterModelCallEvent,
            MessageAddedEvent,
        ]
    )


@pytest.fixture
def agent_tool():
    @strands.tools.tool(name="tool_decorated")
    def reverse(random_string: str) -> str:
        return random_string[::-1]

    return reverse


@pytest.fixture
def tool_use(agent_tool):
    return {"name": agent_tool.tool_name, "toolUseId": "123", "input": {"random_string": "I invoked a tool!"}}


@pytest.fixture
def mock_model(tool_use):
    agent_messages: Messages = [
        {
            "role": "assistant",
            "content": [{"toolUse": tool_use}],
        },
        {"role": "assistant", "content": [{"text": "I invoked a tool!"}]},
    ]
    return MockedModelProvider(agent_messages)


@pytest.fixture
def agent(
    mock_model,
    hook_provider,
    agent_tool,
):
    agent = Agent(
        model=mock_model,
        system_prompt="You are a helpful assistant.",
        callback_handler=None,
        tools=[agent_tool],
    )

    hooks = agent.hooks
    hooks.add_hook(hook_provider)

    def assert_message_is_last_message_added(event: MessageAddedEvent):
        assert event.agent.messages[-1] == event.message

    hooks.add_callback(MessageAddedEvent, assert_message_is_last_message_added)

    return agent


@pytest.fixture
def tools_config(agent):
    return agent.tool_config["tools"]


@pytest.fixture
def user():
    class User(BaseModel):
        name: str
        age: int

    return User(name="Jane Doe", age=30)


@pytest.fixture
def mock_sleep():
    with patch.object(strands.event_loop._retry.asyncio, "sleep", new_callable=AsyncMock) as mock:
        yield mock


def test_agent__init__hooks():
    """Verify that the AgentInitializedEvent is emitted on Agent construction."""
    hook_provider = MockHookProvider(event_types=[AgentInitializedEvent])
    agent = Agent(hooks=[hook_provider])

    length, events = hook_provider.get_events()

    assert length == 1

    assert next(events) == AgentInitializedEvent(agent=agent)


def test_agent_tool_call(agent, hook_provider, agent_tool):
    agent.tool.tool_decorated(random_string="a string")

    length, events = hook_provider.get_events()

    tool_use: ToolUse = {"input": {"random_string": "a string"}, "name": "tool_decorated", "toolUseId": ANY}
    result: ToolResult = {"content": [{"text": "gnirts a"}], "status": "success", "toolUseId": ANY}

    assert length == 6

    assert next(events) == BeforeToolCallEvent(
        agent=agent,
        selected_tool=agent_tool,
        tool_use=tool_use,
        invocation_state=ANY,
    )
    assert next(events) == AfterToolCallEvent(
        agent=agent,
        selected_tool=agent_tool,
        tool_use=tool_use,
        invocation_state=ANY,
        result=result,
        duration=ANY,
    )
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[0])
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[1])
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[2])
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[3])

    assert len(agent.messages) == 4

    # Verify duration is a realistic positive value (mocked tool should complete in under 10s)
    after_tool_events = [e for e in hook_provider.events_received if isinstance(e, AfterToolCallEvent)]
    assert len(after_tool_events) == 1
    assert isinstance(after_tool_events[0].duration, float)
    assert 0 <= after_tool_events[0].duration < 10


def test_agent__call__hooks(agent, hook_provider, agent_tool, mock_model, tool_use):
    """Verify that the correct hook events are emitted as part of __call__."""

    result = agent("test message")

    length, events = hook_provider.get_events()

    assert length == 12

    assert next(events) == BeforeInvocationEvent(agent=agent, invocation_state=ANY, messages=agent.messages[0:1])
    assert next(events) == MessageAddedEvent(
        agent=agent,
        message=agent.messages[0],
    )
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY, projected_input_tokens=ANY)
    assert next(events) == AfterModelCallEvent(
        agent=agent,
        invocation_state=ANY,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={
                "content": [{"toolUse": tool_use}],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            },
            stop_reason="tool_use",
        ),
        exception=None,
    )

    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[1])
    assert next(events) == BeforeToolCallEvent(
        agent=agent,
        selected_tool=agent_tool,
        tool_use=tool_use,
        invocation_state=ANY,
    )
    assert next(events) == AfterToolCallEvent(
        agent=agent,
        selected_tool=agent_tool,
        tool_use=tool_use,
        invocation_state=ANY,
        result={"content": [{"text": "!loot a dekovni I"}], "status": "success", "toolUseId": "123"},
        duration=ANY,
    )
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[2])
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY, projected_input_tokens=ANY)
    assert next(events) == AfterModelCallEvent(
        agent=agent,
        invocation_state=ANY,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={
                "role": "assistant",
                "content": [{"text": "I invoked a tool!"}],
                "metadata": ANY,
                "tracking_id": ANY,
            },
            stop_reason="end_turn",
        ),
        exception=None,
    )
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[3])

    assert next(events) == AfterInvocationEvent(agent=agent, invocation_state=ANY, result=result)

    assert len(agent.messages) == 4

    # Verify duration is a realistic positive value
    after_tool_events = [e for e in hook_provider.events_received if isinstance(e, AfterToolCallEvent)]
    assert len(after_tool_events) == 1
    assert isinstance(after_tool_events[0].duration, float)
    assert 0 <= after_tool_events[0].duration < 10


@pytest.mark.asyncio
async def test_agent_stream_async_hooks(agent, hook_provider, agent_tool, mock_model, tool_use, agenerator):
    """Verify that the correct hook events are emitted as part of stream_async."""
    iterator = agent.stream_async("test message")
    await anext(iterator)

    # Verify first event is BeforeInvocationEvent with invocation_state and messages
    assert len(hook_provider.events_received) == 1
    assert hook_provider.events_received[0].invocation_state is not None
    assert hook_provider.events_received[0].messages is not None
    assert hook_provider.events_received[0].messages[0]["role"] == "user"

    # iterate the rest
    result = None
    async for item in iterator:
        if "result" in item:
            result = item["result"]

    length, events = hook_provider.get_events()

    assert length == 12

    assert next(events) == BeforeInvocationEvent(agent=agent, invocation_state=ANY, messages=agent.messages[0:1])
    assert next(events) == MessageAddedEvent(
        agent=agent,
        message=agent.messages[0],
    )
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY, projected_input_tokens=ANY)
    assert next(events) == AfterModelCallEvent(
        agent=agent,
        invocation_state=ANY,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={
                "content": [{"toolUse": tool_use}],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            },
            stop_reason="tool_use",
        ),
        exception=None,
    )

    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[1])
    assert next(events) == BeforeToolCallEvent(
        agent=agent,
        selected_tool=agent_tool,
        tool_use=tool_use,
        invocation_state=ANY,
    )
    assert next(events) == AfterToolCallEvent(
        agent=agent,
        selected_tool=agent_tool,
        tool_use=tool_use,
        invocation_state=ANY,
        result={"content": [{"text": "!loot a dekovni I"}], "status": "success", "toolUseId": "123"},
        duration=ANY,
    )
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[2])
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY, projected_input_tokens=ANY)
    assert next(events) == AfterModelCallEvent(
        agent=agent,
        invocation_state=ANY,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={
                "role": "assistant",
                "content": [{"text": "I invoked a tool!"}],
                "metadata": ANY,
                "tracking_id": ANY,
            },
            stop_reason="end_turn",
        ),
        exception=None,
    )
    assert next(events) == MessageAddedEvent(agent=agent, message=agent.messages[3])

    assert next(events) == AfterInvocationEvent(agent=agent, invocation_state=ANY, result=result)

    assert len(agent.messages) == 4

    # Verify duration is a realistic positive value
    after_tool_events = [e for e in hook_provider.events_received if isinstance(e, AfterToolCallEvent)]
    assert len(after_tool_events) == 1
    assert isinstance(after_tool_events[0].duration, float)
    assert 0 <= after_tool_events[0].duration < 10


@pytest.mark.filterwarnings("ignore:Agent.structured_output method is deprecated:DeprecationWarning")
def test_agent_structured_output_hooks(agent, hook_provider, user, agenerator):
    """Verify that the correct hook events are emitted as part of structured_output."""

    agent.model.structured_output = Mock(return_value=agenerator([{"output": user}]))
    agent.structured_output(type(user), "example prompt")

    length, events = hook_provider.get_events()

    assert length == 2

    assert next(events) == BeforeInvocationEvent(agent=agent, invocation_state=ANY)
    assert next(events) == AfterInvocationEvent(agent=agent, invocation_state=ANY)

    assert len(agent.messages) == 0  # no new messages added


@pytest.mark.filterwarnings("ignore:Agent.structured_output_async method is deprecated:DeprecationWarning")
@pytest.mark.asyncio
async def test_agent_structured_async_output_hooks(agent, hook_provider, user, agenerator):
    """Verify that the correct hook events are emitted as part of structured_output_async."""

    agent.model.structured_output = Mock(return_value=agenerator([{"output": user}]))
    await agent.structured_output_async(type(user), "example prompt")

    length, events = hook_provider.get_events()

    assert length == 2

    assert next(events) == BeforeInvocationEvent(agent=agent, invocation_state=ANY)
    assert next(events) == AfterInvocationEvent(agent=agent, invocation_state=ANY)

    assert len(agent.messages) == 0  # no new messages added


@pytest.mark.asyncio
async def test_hook_retry_on_successful_call():
    """Test that hooks can retry even on successful model calls based on response content."""

    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"text": "Short"}],
            },
            {
                "role": "assistant",
                "content": [{"text": "This is a much longer and more detailed response"}],
            },
        ],
        usages=[
            {"inputTokens": 1000, "outputTokens": 1000, "totalTokens": 2000},
            {"inputTokens": 7, "outputTokens": 7, "totalTokens": 14},
        ],
    )

    # Hook that retries if response is too short
    class MinLengthRetryHook:
        def __init__(self, min_length=10):
            self.min_length = min_length
            self.call_count = 0

        def register_hooks(self, registry):
            registry.add_callback(strands.hooks.AfterModelCallEvent, self.handle_after_model_call)

        async def handle_after_model_call(self, event):
            self.call_count += 1

            # Check successful responses for minimum length
            if event.stop_response:
                message = event.stop_response.message
                text_content = "".join(block.get("text", "") for block in message.get("content", []))

                if len(text_content) < self.min_length:
                    event.retry = True

    retry_hook = MinLengthRetryHook(min_length=10)
    agent = Agent(model=mock_provider, hooks=[retry_hook])

    result = agent("Generate a response")

    # Verify hook was called twice (once for short response, once for long)
    assert retry_hook.call_count == 2

    # Verify final result is the longer response
    assert result.message["content"][0]["text"] == "This is a much longer and more detailed response"

    # https://github.com/strands-agents/harness-sdk/issues/3623: retried calls still incur billable usage.
    tru_usage = agent.event_loop_metrics.accumulated_usage
    exp_usage = {"inputTokens": 1007, "outputTokens": 1007, "totalTokens": 2014}
    assert tru_usage == exp_usage


@pytest.mark.asyncio
async def test_hook_retry_on_exception_basic(alist, mock_sleep):
    """Test that hooks can retry model calls on exceptions."""

    class CustomException(Exception):
        pass

    model = MagicMock()
    model.stream.side_effect = [
        CustomException("First attempt fails"),
        MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"text": "Success after retry"}],
                },
            ]
        ).stream([]),
    ]

    # Hook that enables retry on CustomException
    class RetryHook:
        def __init__(self):
            self.after_model_call_count = 0

        def register_hooks(self, registry):
            registry.add_callback(strands.hooks.AfterModelCallEvent, self.handle_after_model_call)

        async def handle_after_model_call(self, event):
            self.after_model_call_count += 1
            if event.exception and isinstance(event.exception, CustomException):
                event.retry = True

    retry_hook = RetryHook()
    agent = Agent(model=model, hooks=[retry_hook])

    result = agent("Test retry")

    # Verify the hook was called twice (once for failure, once for success)
    assert retry_hook.after_model_call_count == 2
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Success after retry"


@pytest.mark.asyncio
async def test_hook_retry_not_set_on_success(alist):
    """Test that model is not retried when hook doesn't set retry on success."""
    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"text": "First successful response"}],
            },
        ]
    )

    # Hook that tries to set retry=True even on success
    class NoRetryHook:
        def __init__(self):
            self.call_count = 0

        def register_hooks(self, registry):
            registry.add_callback(strands.hooks.AfterModelCallEvent, self.handle_after_model_call)

        async def handle_after_model_call(self, event):
            self.call_count += 1
            # Try to set retry even on success
            # Don't set retry (leave it as False)

    retry_hook = NoRetryHook()
    agent = Agent(model=mock_provider, hooks=[retry_hook])

    result = agent("Test no retry when not set")

    # Should only be called once since retry was not set
    assert retry_hook.call_count == 1
    assert result.message["content"][0]["text"] == "First successful response"


@pytest.mark.asyncio
async def test_hook_retry_with_limit(alist, mock_sleep):
    """Test that hooks can control retry limits."""

    class CustomException(Exception):
        pass

    model = MagicMock()
    model.stream.side_effect = [
        CustomException("Attempt 1 fails"),
        CustomException("Attempt 2 fails"),
        CustomException("Attempt 3 fails"),
    ]

    # Hook that allows max 2 retries
    class LimitedRetryHook:
        def __init__(self, max_retries=2):
            self.max_retries = max_retries
            self.retry_count = 0
            self.call_count = 0

        def register_hooks(self, registry):
            registry.add_callback(strands.hooks.AfterModelCallEvent, self.handle_after_model_call)

        async def handle_after_model_call(self, event):
            self.call_count += 1
            if event.exception and isinstance(event.exception, CustomException):
                if self.retry_count < self.max_retries:
                    self.retry_count += 1
                    event.retry = True
                # else: let exception propagate

    retry_hook = LimitedRetryHook(max_retries=2)
    agent = Agent(model=model, hooks=[retry_hook])

    with pytest.raises(CustomException, match="Attempt 3 fails"):
        await agent("Test limited retries")

    # Should be called 3 times: initial + 2 retries
    assert retry_hook.call_count == 3
    assert retry_hook.retry_count == 2


@pytest.mark.asyncio
async def test_hook_retry_multiple_hooks(alist, mock_sleep):
    """Test that multiple hooks can modify retry and last one wins."""

    class CustomException(Exception):
        pass

    model = MagicMock()
    model.stream.side_effect = [
        CustomException("First attempt fails"),
        MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"text": "Success"}],
                },
            ]
        ).stream([]),
    ]

    async def retry_enabler(event: AfterModelCallEvent):
        if event.exception:
            event.retry = True

    async def another_retry_enabler(event: AfterModelCallEvent):
        if event.exception:
            event.retry = True

    agent = Agent(model=model)
    agent.hooks.add_callback(AfterModelCallEvent, retry_enabler)
    agent.hooks.add_callback(AfterModelCallEvent, another_retry_enabler)

    result = agent("Test multiple hooks")

    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Success"


@pytest.mark.asyncio
async def test_hook_retry_last_hook_wins(alist, mock_sleep):
    """Test that when multiple hooks set retry, the last-called hook wins.

    Note: AfterModelCallEvent callbacks are invoked in reverse order, so the first
    registered hook is called last.
    """

    class CustomException(Exception):
        pass

    call_count = [0]

    def mock_stream(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            raise CustomException("First attempt fails")
        else:
            raise CustomException(f"Should not be called (call {call_count[0]})")

    model = MagicMock()
    model.stream = mock_stream

    async def retry_enabler(event: AfterModelCallEvent):
        """Called first due to reverse order."""
        if event.exception:
            event.retry = True

    async def retry_disabler(event: AfterModelCallEvent):
        """Called last, so it wins."""
        if event.exception:
            event.retry = False

    agent = Agent(model=model)
    agent.hooks.add_callback(AfterModelCallEvent, retry_disabler)  # Registered first, called last
    agent.hooks.add_callback(AfterModelCallEvent, retry_enabler)  # Registered second, called first

    # Should raise exception since last-called hook disabled retry
    with pytest.raises(CustomException, match="First attempt fails"):
        agent("Test last hook wins")

    # Verify stream was only called once
    assert call_count[0] == 1


@pytest.mark.asyncio
async def test_hook_retry_with_throttle_exception(alist, mock_sleep):
    """Test that hook retry works alongside existing throttle retry."""

    class CustomException(Exception):
        pass

    model = MagicMock()
    model.stream.side_effect = [
        CustomException("Custom error"),
        ModelThrottledException("ThrottlingException"),
        ModelThrottledException("ThrottlingException"),
        MockedModelProvider(
            [
                {
                    "role": "assistant",
                    "content": [{"text": "Success after mixed retries"}],
                },
            ]
        ).stream([]),
    ]

    async def handle_after_model_call(event: AfterModelCallEvent):
        if event.exception and isinstance(event.exception, CustomException):
            event.retry = True

    agent = Agent(model=model)
    agent.hooks.add_callback(AfterModelCallEvent, handle_after_model_call)

    result = agent("Test mixed retries")

    # Should succeed after: custom retry + 2 throttle retries
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Success after mixed retries"


def test_before_invocation_event_message_modification():
    """Test that hooks can modify messages in BeforeInvocationEvent for input guardrails."""
    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"text": "I received your redacted message"}],
            },
        ]
    )

    modified_content = None

    async def input_guardrail_hook(event: BeforeInvocationEvent):
        """Simulates a guardrail that redacts sensitive content."""
        nonlocal modified_content
        if event.messages is not None:
            for message in event.messages:
                if message.get("role") == "user":
                    content = message.get("content", [])
                    for block in content:
                        if "text" in block and "SECRET" in block["text"]:
                            # Redact sensitive content in-place
                            block["text"] = block["text"].replace("SECRET", "[REDACTED]")
            modified_content = event.messages[0]["content"][0]["text"]

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(BeforeInvocationEvent, input_guardrail_hook)

    agent("My password is SECRET123")

    # Verify the message was modified before being processed
    assert modified_content == "My password is [REDACTED]123"
    # Verify the modified message was added to agent's conversation history
    assert agent.messages[0]["content"][0]["text"] == "My password is [REDACTED]123"


def test_before_invocation_event_message_overwrite():
    """Test that hooks can overwrite messages in BeforeInvocationEvent."""
    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"text": "I received your message message"}],
            },
        ]
    )

    async def overwrite_input_hook(event: BeforeInvocationEvent):
        event.messages = [{"role": "user", "content": [{"text": "GOODBYE"}]}]

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(BeforeInvocationEvent, overwrite_input_hook)

    agent("HELLO")

    # Verify the message was overwritten to agent's conversation history
    assert agent.messages[0]["content"][0]["text"] == "GOODBYE"


@pytest.mark.filterwarnings("ignore:Agent.structured_output_async method is deprecated:DeprecationWarning")
@pytest.mark.asyncio
async def test_before_invocation_event_messages_none_in_structured_output(agenerator):
    """Test that BeforeInvocationEvent.messages is None when called from deprecated structured_output."""

    class Person(BaseModel):
        name: str
        age: int

    mock_provider = MockedModelProvider([])
    mock_provider.structured_output = Mock(return_value=agenerator([{"output": Person(name="Test", age=30)}]))

    received_messages = "not_set"

    async def capture_messages_hook(event: BeforeInvocationEvent):
        nonlocal received_messages
        received_messages = event.messages

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(BeforeInvocationEvent, capture_messages_hook)

    await agent.structured_output_async(Person, "Test prompt")

    # structured_output_async uses deprecated path that doesn't pass messages
    assert received_messages is None


def test_after_invocation_resume_triggers_new_invocation():
    """Test that setting resume on AfterInvocationEvent re-invokes the agent."""
    mock_provider = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "First response"}]},
            {"role": "assistant", "content": [{"text": "Second response"}]},
        ]
    )

    resume_count = 0

    async def resume_once(event: AfterInvocationEvent):
        nonlocal resume_count
        if resume_count == 0:
            resume_count += 1
            event.resume = "continue"

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(AfterInvocationEvent, resume_once)

    result = agent("start")

    # Agent should have been invoked twice
    assert resume_count == 1
    assert result.message["content"][0]["text"] == "Second response"
    # 4 messages: user1, assistant1, user2 (resume), assistant2
    assert len(agent.messages) == 4
    assert agent.messages[0]["content"][0]["text"] == "start"
    assert agent.messages[2]["content"][0]["text"] == "continue"


def test_after_invocation_resume_none_does_not_loop():
    """Test that resume=None (default) does not re-invoke the agent."""
    mock_provider = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "Only response"}]},
        ]
    )

    call_count = 0

    async def no_resume(event: AfterInvocationEvent):
        nonlocal call_count
        call_count += 1
        # Don't set resume - should remain None

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(AfterInvocationEvent, no_resume)

    result = agent("hello")

    assert call_count == 1
    assert result.message["content"][0]["text"] == "Only response"


def test_after_invocation_resume_fires_before_invocation_event():
    """Test that resume triggers BeforeInvocationEvent on each iteration."""
    mock_provider = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "First"}]},
            {"role": "assistant", "content": [{"text": "Second"}]},
        ]
    )

    before_invocation_count = 0
    after_invocation_count = 0

    async def count_before(event: BeforeInvocationEvent):
        nonlocal before_invocation_count
        before_invocation_count += 1

    async def resume_once(event: AfterInvocationEvent):
        nonlocal after_invocation_count
        after_invocation_count += 1
        if after_invocation_count == 1:
            event.resume = "next"

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(BeforeInvocationEvent, count_before)
    agent.hooks.add_callback(AfterInvocationEvent, resume_once)

    agent("start")

    # BeforeInvocationEvent should fire for both the initial and resumed invocation
    assert before_invocation_count == 2
    assert after_invocation_count == 2


def test_after_invocation_resume_multiple_times():
    """Test that resume can chain multiple re-invocations."""
    mock_provider = MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "Response 1"}]},
            {"role": "assistant", "content": [{"text": "Response 2"}]},
            {"role": "assistant", "content": [{"text": "Response 3"}]},
        ]
    )

    resume_count = 0

    async def resume_twice(event: AfterInvocationEvent):
        nonlocal resume_count
        if resume_count < 2:
            resume_count += 1
            event.resume = f"iteration {resume_count + 1}"

    agent = Agent(model=mock_provider)
    agent.hooks.add_callback(AfterInvocationEvent, resume_twice)

    result = agent("iteration 1")

    assert resume_count == 2
    assert result.message["content"][0]["text"] == "Response 3"
    # 6 messages: 3 user + 3 assistant
    assert len(agent.messages) == 6


def test_after_invocation_resume_handles_interrupt_with_responses():
    """Test that a hook can handle an interrupt by resuming with interrupt responses."""

    @strands.tools.tool(name="interruptable_tool")
    def interruptable_tool(value: str) -> str:
        return value

    tool_use_id = "tool-1"
    mock_provider = MockedModelProvider(
        [
            # First invocation: model calls the tool, which will be interrupted
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": tool_use_id,
                            "name": "interruptable_tool",
                            "input": {"value": "test"},
                        }
                    }
                ],
            },
            # Second invocation (after interrupt resume): model gives final response
            {"role": "assistant", "content": [{"text": "Completed after interrupt"}]},
        ]
    )

    def interrupt_tool(event: BeforeToolCallEvent):
        """Interrupt before tool execution; returns stored response on second call."""
        if event.tool_use["name"] == "interruptable_tool":
            event.interrupt("approval_needed", reason="Need human approval")

    async def handle_interrupt_via_resume(event: AfterInvocationEvent):
        """Hook that automatically handles interrupts by resuming with responses."""
        if event.result and event.result.stop_reason == "interrupt":
            responses = []
            for interrupt in event.result.interrupts:
                responses.append({"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}})
            event.resume = responses

    agent = Agent(model=mock_provider, tools=[interruptable_tool], callback_handler=None)
    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)
    agent.hooks.add_callback(AfterInvocationEvent, handle_interrupt_via_resume)

    result = agent("do something")

    # The hook handled the interrupt automatically — agent completed normally
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Completed after interrupt"
    # Interrupt state should be cleared after successful resume
    assert agent._interrupt_state.activated is False


def test_after_invocation_resume_with_invalid_input_during_interrupt():
    """Test that resuming with non-interrupt input while interrupt is active raises TypeError."""

    @strands.tools.tool(name="interruptable_tool")
    def interruptable_tool(value: str) -> str:
        return value

    tool_use_id = "tool-1"
    mock_provider = MockedModelProvider(
        [
            # First invocation: model calls the tool, which will be interrupted
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": tool_use_id,
                            "name": "interruptable_tool",
                            "input": {"value": "test"},
                        }
                    }
                ],
            },
        ]
    )

    def interrupt_tool(event: BeforeToolCallEvent):
        if event.tool_use["name"] == "interruptable_tool":
            event.interrupt("approval_needed", reason="Need approval")

    async def resume_with_bad_input(event: AfterInvocationEvent):
        """Hook that incorrectly tries to resume with a plain string during interrupt."""
        if event.result and event.result.stop_reason == "interrupt":
            event.resume = "this is wrong"

    agent = Agent(model=mock_provider, tools=[interruptable_tool], callback_handler=None)
    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)
    agent.hooks.add_callback(AfterInvocationEvent, resume_with_bad_input)

    with pytest.raises(TypeError, match="must resume from interrupt with list of interruptResponse's"):
        agent("do something")


def test_after_invocation_resume_interrupt_without_resume_returns_to_caller():
    """Test that an interrupt without resume set returns the interrupt to the caller."""

    @strands.tools.tool(name="interruptable_tool")
    def interruptable_tool(value: str) -> str:
        return value

    tool_use_id = "tool-1"
    mock_provider = MockedModelProvider(
        [
            # First invocation: model calls the tool, which will be interrupted
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": tool_use_id,
                            "name": "interruptable_tool",
                            "input": {"value": "test"},
                        }
                    }
                ],
            },
            # Second invocation (caller resumes manually): final response
            {"role": "assistant", "content": [{"text": "Done after manual resume"}]},
        ]
    )

    def interrupt_tool(event: BeforeToolCallEvent):
        if event.tool_use["name"] == "interruptable_tool":
            event.interrupt("approval_needed", reason="Need approval")

    agent = Agent(model=mock_provider, tools=[interruptable_tool], callback_handler=None)
    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)

    # First call: hits interrupt, no hook handles it, returns to caller
    result = agent("do something")
    assert result.stop_reason == "interrupt"
    assert len(result.interrupts) == 1
    assert result.interrupts[0].name == "approval_needed"
    assert agent._interrupt_state.activated is True

    # Caller manually resumes with interrupt responses
    interrupt_id = result.interrupts[0].id
    result = agent([{"interruptResponse": {"interruptId": interrupt_id, "response": "yes"}}])
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Done after manual resume"
    assert agent._interrupt_state.activated is False


def test_after_invocation_resume_interrupt_during_resumed_invocation():
    """Test that an interrupt during a resumed invocation can be handled by the hook."""

    @strands.tools.tool(name="interruptable_tool")
    def interruptable_tool(value: str) -> str:
        return value

    tool_use_id = "tool-1"
    mock_provider = MockedModelProvider(
        [
            # First invocation: simple text response (no tool call)
            {"role": "assistant", "content": [{"text": "First response"}]},
            # Second invocation (resumed): triggers a tool call which will be interrupted
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": tool_use_id,
                            "name": "interruptable_tool",
                            "input": {"value": "test"},
                        }
                    }
                ],
            },
            # Third invocation (after interrupt handled via resume): final response
            {"role": "assistant", "content": [{"text": "Final response"}]},
        ]
    )

    invocation_count = 0

    async def resume_hook(event: AfterInvocationEvent):
        """Resume with new input on first call, handle interrupt on second."""
        nonlocal invocation_count
        invocation_count += 1
        if invocation_count == 1:
            # First invocation done, resume with new input
            event.resume = "continue"
        elif event.result and event.result.stop_reason == "interrupt":
            # Second invocation hit interrupt, handle it
            responses = []
            for interrupt in event.result.interrupts:
                responses.append({"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}})
            event.resume = responses

    def interrupt_tool(event: BeforeToolCallEvent):
        if event.tool_use["name"] == "interruptable_tool":
            event.interrupt("approval_needed", reason="Need approval")

    agent = Agent(model=mock_provider, tools=[interruptable_tool], callback_handler=None)
    agent.hooks.add_callback(AfterInvocationEvent, resume_hook)
    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)

    result = agent("start")

    # All three invocations happened within a single agent call
    assert invocation_count == 3
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Final response"
    assert agent._interrupt_state.activated is False


def test_hooks_param_accepts_callable():
    """Verify that a plain callable can be passed via hooks parameter."""
    events_received = []

    def my_callback(event: AgentInitializedEvent) -> None:
        events_received.append(event)

    agent = Agent(hooks=[my_callback], callback_handler=None)

    assert len(events_received) == 1
    assert isinstance(events_received[0], AgentInitializedEvent)
    assert events_received[0].agent is agent


def test_hooks_param_accepts_mixed_list():
    """Verify that a mix of HookProviders and callables can be passed."""
    callback_events = []

    def my_callback(event: AgentInitializedEvent) -> None:
        callback_events.append(event)

    provider = MockHookProvider(event_types=[AgentInitializedEvent])

    agent = Agent(hooks=[provider, my_callback], callback_handler=None)

    assert len(callback_events) == 1
    assert callback_events[0].agent is agent
    length, _ = provider.get_events()
    assert length == 1


def test_hooks_param_invalid_hook_raises_error():
    """Verify that passing an invalid hook raises ValueError."""
    with pytest.raises(ValueError, match="Invalid hook"):
        Agent(hooks=["not_a_hook"], callback_handler=None)  # type: ignore


def test_hooks_param_callable_invoked_during_lifecycle():
    """Verify callable hooks fire during agent lifecycle."""
    before_events = []

    def on_before(event: BeforeInvocationEvent) -> None:
        before_events.append(event)

    mock_model = MockedModelProvider([{"role": "assistant", "content": [{"text": "Hello!"}]}])
    agent = Agent(model=mock_model, hooks=[on_before], callback_handler=None)
    agent("test")

    assert len(before_events) == 1
    assert isinstance(before_events[0], BeforeInvocationEvent)


def test_before_model_call_hook_interrupt_stops_and_resumes_at_model_call():
    interrupt = Interrupt(id="v1:model_call:approve", name="approve", reason="Approve the model call?")
    responses_seen = []

    def gate_model_call(event: BeforeModelCallEvent):
        registered = event.agent._interrupt_state.interrupts.get(interrupt.id)
        if registered is None or registered.response is None:
            raise InterruptException(interrupt)
        responses_seen.append(registered.response)

    agent = Agent(
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "Approved"}]}]),
        callback_handler=None,
    )
    agent.hooks.add_callback(BeforeModelCallEvent, gate_model_call)

    interrupted = agent("do something")
    assert interrupted.stop_reason == "interrupt"
    assert [pending.id for pending in interrupted.interrupts] == [interrupt.id]
    assert len(agent.messages) == 1

    result = agent([{"interruptResponse": {"interruptId": interrupt.id, "response": "yes"}}])
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Approved"
    assert responses_seen == ["yes"]
    assert agent._interrupt_state.activated is False
