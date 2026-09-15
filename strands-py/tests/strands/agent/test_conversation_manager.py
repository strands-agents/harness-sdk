from unittest.mock import MagicMock, patch

import pytest

from strands import tool
from strands.agent.agent import Agent
from strands.agent.conversation_manager.conversation_manager import ConversationManager
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
from strands.hooks.events import BeforeModelCallEvent
from strands.hooks.registry import HookProvider, HookRegistry
from strands.models.model import Model
from strands.types.exceptions import ContextWindowOverflowException
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def conversation_manager(request):
    params = {
        "window_size": 2,
        "should_truncate_results": False,
    }
    if hasattr(request, "param"):
        params.update(request.param)

    return SlidingWindowConversationManager(**params)


@pytest.mark.parametrize(
    ("conversation_manager", "messages", "expected_messages"),
    [
        # 0 - Message count under max window size - Latest assistant
        (
            {"window_size": 3},
            [
                {"role": "user", "content": [{"text": "Hello"}]},
                {"role": "assistant", "content": [{"text": "Hi there"}]},
            ],
            [
                {"role": "user", "content": [{"text": "Hello"}]},
                {"role": "assistant", "content": [{"text": "Hi there"}]},
            ],
        ),
        # 1 - Message count under max window size - Latest user
        (
            {"window_size": 2},
            [
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
            ],
            [
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
            ],
        ),
        # 2 - Keep user message
        (
            {"window_size": 2},
            [
                {"role": "user", "content": [{"text": "Hello"}]},
            ],
            [{"role": "user", "content": [{"text": "Hello"}]}],
        ),
        # 3 - Keep dangling assistant message with tool use
        (
            {"window_size": 3},
            [
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
            ],
            [{"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]}],
        ),
        # 4 - Remove dangling assistant message with tool use - User tool result remains
        (
            {"window_size": 3},
            [
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
            ],
            [
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
            ],
        ),
        # 5 - Remove dangling assistant message with tool use and user message without tool result
        # Must start with a user message, so we skip the assistant message
        (
            {"window_size": 3},
            [
                {"role": "user", "content": [{"text": "First"}]},
                {"role": "assistant", "content": [{"text": "First response"}]},
                {"role": "user", "content": [{"text": "Use a tool"}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
            ],
            [
                {"role": "user", "content": [{"text": "Use a tool"}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
            ],
        ),
        # 6 - Message count above max window size - Basic drop
        (
            {"window_size": 2},
            [
                {"role": "user", "content": [{"text": "First message"}]},
                {"role": "assistant", "content": [{"text": "First response"}]},
                {"role": "user", "content": [{"text": "Second message"}]},
                {"role": "assistant", "content": [{"text": "Second response"}]},
            ],
            [
                {"role": "user", "content": [{"text": "Second message"}]},
                {"role": "assistant", "content": [{"text": "Second response"}]},
            ],
        ),
        # 7 - Message count above max window size - Preserve tool use/tool result pairs
        # Cannot start with assistant or orphaned toolResult, so trim advances to next plain user message
        (
            {"window_size": 2},
            [
                {"role": "user", "content": [{"text": "Hello"}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
                {"role": "assistant", "content": [{"text": "Done"}]},
                {"role": "user", "content": [{"text": "Next"}]},
            ],
            [
                {"role": "user", "content": [{"text": "Next"}]},
            ],
        ),
        # 8 - Test sliding window behavior - preserve tool use/result pairs across cut boundary
        # Must start with user message (not assistant, not orphaned toolResult), so trim advances to plain user msg
        (
            {"window_size": 3},
            [
                {"role": "user", "content": [{"text": "First message"}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
                {"role": "assistant", "content": [{"text": "Response after tool use"}]},
                {"role": "user", "content": [{"text": "Follow up"}]},
            ],
            [
                {"role": "user", "content": [{"text": "Follow up"}]},
            ],
        ),
        # 9 - Test sliding window with multiple tool pairs that need preservation
        # Must start with user message; orphaned toolResult is skipped, lands on plain user text
        (
            {"window_size": 4},
            [
                {"role": "user", "content": [{"text": "First message"}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "123", "name": "tool1", "input": {}}}]},
                {"role": "user", "content": [{"toolResult": {"toolUseId": "123", "content": [], "status": "success"}}]},
                {"role": "assistant", "content": [{"toolUse": {"toolUseId": "456", "name": "tool2", "input": {}}}]},
                {"role": "user", "content": [{"toolResult": {"toolUseId": "456", "content": [], "status": "success"}}]},
                {"role": "assistant", "content": [{"text": "Final response"}]},
                {"role": "user", "content": [{"text": "Another question"}]},
            ],
            [
                {"role": "user", "content": [{"text": "Another question"}]},
            ],
        ),
    ],
    indirect=["conversation_manager"],
)
def test_apply_management(conversation_manager, messages, expected_messages):
    test_agent = Agent(messages=messages)
    conversation_manager.apply_management(test_agent)

    assert messages == expected_messages


def test_sliding_window_forces_user_message_start():
    """Test that trimmed conversation always starts with a user message (GitHub #2085)."""
    manager = SlidingWindowConversationManager(window_size=3, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi"}]},
        {"role": "user", "content": [{"text": "How are you?"}]},
        {"role": "assistant", "content": [{"text": "Good"}]},
        {"role": "user", "content": [{"text": "Great"}]},
    ]
    test_agent = Agent(messages=messages)
    manager.apply_management(test_agent)

    assert len(messages) == 3
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == [{"text": "How are you?"}]


def test_sliding_window_happy_path_preserves_window_size():
    """In a typical user/assistant conversation, trimming preserves close to window_size messages."""
    manager = SlidingWindowConversationManager(window_size=4, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "First"}]},
        {"role": "assistant", "content": [{"text": "First response"}]},
        {"role": "user", "content": [{"text": "Second"}]},
        {"role": "assistant", "content": [{"text": "Second response"}]},
        {"role": "user", "content": [{"text": "Third"}]},
        {"role": "assistant", "content": [{"text": "Third response"}]},
    ]
    test_agent = Agent(messages=messages)
    manager.apply_management(test_agent)

    assert len(messages) == 4
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == [{"text": "Second"}]


def test_sliding_window_conversation_manager_with_untrimmable_history_raises_context_window_overflow_exception():
    manager = SlidingWindowConversationManager(1, False)
    messages = [
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "456", "name": "tool1", "input": {}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "789", "content": [], "status": "success"}}]},
    ]
    original_messages = messages.copy()
    test_agent = Agent(messages=messages)

    with pytest.raises(ContextWindowOverflowException):
        manager.reduce_context(test_agent, e=RuntimeError("context overflow"))

    assert messages == original_messages


def test_sliding_window_no_valid_trim_point_without_error_does_not_raise():
    """When no valid trim point exists during routine management (no error), messages are left unchanged."""
    manager = SlidingWindowConversationManager(1, False)
    messages = [
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "456", "name": "tool1", "input": {}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "789", "content": [], "status": "success"}}]},
    ]
    original_messages = messages.copy()
    test_agent = Agent(messages=messages)

    manager.apply_management(test_agent)

    assert messages == original_messages


def test_sliding_window_tool_heavy_conversation_falls_back_to_tool_pair_boundary():
    """Tool-heavy conversations trim to assistant(toolUse) + user(toolResult) boundary."""
    manager = SlidingWindowConversationManager(window_size=4, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "Review this PR"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "get_diff", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": "diff"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "2", "name": "get_file", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "2", "content": [{"text": "file"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "3", "name": "get_tree", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "3", "content": [{"text": "tree"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"text": "Here is my review"}]},
    ]
    test_agent = Agent(messages=messages)

    manager.reduce_context(test_agent, e=Exception("context window overflow"))

    # Should trim to first assistant(toolUse) + user(toolResult) pair after trim_index
    # With 8 messages and window_size=4, trim_index starts at 4. First fallback at index 5 (toolUseId "3").
    assert len(messages) == 3
    assert messages[0]["role"] == "assistant"
    assert messages[0]["content"][0]["toolUse"]["toolUseId"] == "3"
    assert messages[1]["role"] == "user"
    assert any("toolResult" in content for content in messages[1]["content"])


def test_sliding_window_prefers_plain_user_message_over_tool_pair_fallback():
    """Plain user messages are preferred over assistant+toolResult fallback when both exist."""
    manager = SlidingWindowConversationManager(window_size=2, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "First"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": "result"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"text": "Response"}]},
        {"role": "user", "content": [{"text": "Plain user message"}]},
        {"role": "assistant", "content": [{"text": "Final response"}]},
    ]
    test_agent = Agent(messages=messages)

    manager.apply_management(test_agent)

    # Should prefer the plain user message, not the assistant+toolResult fallback
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == [{"text": "Plain user message"}]


def test_sliding_window_conversation_manager_with_tool_results_truncated():
    large_text = "A" * 300 + "B" * 300 + "C" * 300
    manager = SlidingWindowConversationManager(1)
    messages = [
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "456", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "789", "content": [{"text": large_text}], "status": "success"}}],
        },
    ]
    test_agent = Agent(messages=messages)

    manager.reduce_context(test_agent, e=RuntimeError("context overflow"))

    result_text = messages[1]["content"][0]["toolResult"]["content"][0]["text"]
    assert result_text.startswith("A" * 200)
    assert result_text.endswith("C" * 200)
    assert "... [truncated:" in result_text
    # Status must NOT be changed to error
    assert messages[1]["content"][0]["toolResult"]["status"] == "success"


def test_sliding_window_proactive_compression_skips_tool_result_truncation():
    """Proactive compression (e=None) should only trim messages, not truncate tool results."""
    large_text = "A" * 300 + "B" * 300 + "C" * 300
    manager = SlidingWindowConversationManager(window_size=2)
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "456", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "789", "content": [{"text": large_text}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"text": "Done"}]},
        {"role": "user", "content": [{"text": "Next question"}]},
    ]
    test_agent = Agent(messages=messages)

    manager.reduce_context(test_agent)  # e=None (proactive)

    # Tool results should NOT be truncated during proactive compression
    for msg in messages:
        for content in msg.get("content", []):
            if "toolResult" in content:
                for item in content["toolResult"].get("content", []):
                    if "text" in item:
                        assert "... [truncated:" not in item["text"]


def test_null_conversation_manager_reduce_context_proactive_returns_silently():
    """Proactive compression (e=None) returns silently without raising."""
    manager = NullConversationManager()
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there"}]},
    ]
    original_messages = messages.copy()
    test_agent = Agent(messages=messages)

    manager.apply_management(test_agent)

    # Proactive call (e=None) should not raise
    manager.reduce_context(test_agent)

    assert messages == original_messages


def test_null_conversation_manager_reduce_context_reactive_raises_overflow():
    """Reactive overflow (e is not None) re-raises the exception."""
    manager = NullConversationManager()
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there"}]},
    ]
    test_agent = Agent(messages=messages)

    with pytest.raises(ContextWindowOverflowException):
        manager.reduce_context(test_agent, e=ContextWindowOverflowException("overflow"))


def test_null_conversation_manager_reduce_context_with_exception_raises_same_exception():
    """Test that NullConversationManager doesn't modify messages."""
    manager = NullConversationManager()
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there"}]},
    ]
    original_messages = messages.copy()
    test_agent = Agent(messages=messages)

    manager.apply_management(test_agent)

    with pytest.raises(RuntimeError):
        manager.reduce_context(messages, RuntimeError("test"))

    assert messages == original_messages


def test_null_conversation_does_not_restore_with_incorrect_state():
    """Test that NullConversationManager doesn't modify messages."""
    manager = NullConversationManager()

    with pytest.raises(ValueError):
        manager.restore_from_session({})


# ==============================================================================
# Per-Turn Management Tests
# ==============================================================================


def test_per_turn_parameter_validation():
    """Test per_turn parameter validation."""
    # Valid values
    assert SlidingWindowConversationManager(per_turn=False).per_turn is False
    assert SlidingWindowConversationManager(per_turn=True).per_turn is True
    assert SlidingWindowConversationManager(per_turn=3).per_turn == 3


def test_per_turn_zero_raises_value_error():
    with pytest.raises(ValueError, match="per_turn"):
        SlidingWindowConversationManager(per_turn=0)


def test_per_turn_negative_raises_value_error():
    with pytest.raises(ValueError, match="per_turn"):
        SlidingWindowConversationManager(per_turn=-5)


def test_conversation_manager_is_hook_provider():
    """Test that ConversationManager implements HookProvider protocol."""
    manager = NullConversationManager()
    assert isinstance(manager, HookProvider)


def test_derived_class_does_not_need_to_implement_register_hooks():
    """Test that derived classes don't need to override register_hooks for backwards compatibility."""
    from strands.agent.conversation_manager.conversation_manager import ConversationManager

    class MinimalConversationManager(ConversationManager):
        """A minimal implementation that only implements abstract methods."""

        def apply_management(self, agent, **kwargs):
            pass

        def reduce_context(self, agent, e=None, **kwargs):
            pass

    # Should be able to instantiate without implementing register_hooks
    manager = MinimalConversationManager()
    registry = HookRegistry()

    # Should work without error — the base class always registers the hook
    manager.register_hooks(registry)
    # Base class always registers the proactive compression hook
    assert registry.has_callbacks()


def test_per_turn_hooks_registration():
    """Test that hooks are registered when conversation_manager implements HookProvider."""
    manager = SlidingWindowConversationManager(per_turn=True)
    assert isinstance(manager, HookProvider)

    registry = HookRegistry()
    manager.register_hooks(registry)
    assert registry.has_callbacks()


def test_per_turn_false_no_management_during_loop():
    """Test that per_turn=False only manages in finally block."""
    manager = SlidingWindowConversationManager(per_turn=False, window_size=100)
    responses = [{"role": "assistant", "content": [{"text": "Response"}]}] * 3
    model = MockedModelProvider(responses)
    agent = Agent(model=model, conversation_manager=manager)

    with patch.object(manager, "apply_management", wraps=manager.apply_management) as mock:
        agent("Test")
        # Should only be called once in finally block (per_turn disabled)
        assert mock.call_count == 1


def test_per_turn_true_manages_each_model_call():
    """Test that per_turn=True applies management before each model call."""
    manager = SlidingWindowConversationManager(per_turn=True, window_size=100)
    responses = [{"role": "assistant", "content": [{"text": "Response"}]}] * 3
    model = MockedModelProvider(responses)
    agent = Agent(model=model, conversation_manager=manager)

    with patch.object(manager, "apply_management", wraps=manager.apply_management) as mock:
        agent("Test")
        # Should be called for each model call + finally block
        # With simple text responses, agent makes 1 model call then stops
        assert mock.call_count >= 1


def test_per_turn_integer_manages_every_n_calls():
    """Test that per_turn=N applies management every N model calls."""
    manager = SlidingWindowConversationManager(per_turn=2, window_size=100)
    # Create responses that trigger multiple model calls
    responses = [
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": f"{i}", "name": "test", "input": {}}}]}
        for i in range(5)
    ] + [{"role": "assistant", "content": [{"text": "Done"}]}]
    model = MockedModelProvider(responses)

    @tool(name="test")
    def test_tool(query: str = "") -> str:
        return "result"

    agent = Agent(model=model, conversation_manager=manager, tools=[test_tool])

    with patch.object(manager, "apply_management", wraps=manager.apply_management) as mock:
        agent("Test")
        # With 6 model calls and per_turn=2: called on 2nd, 4th, 6th + finally
        assert mock.call_count == 4


def test_per_turn_dynamic_change():
    """Test that per_turn can be changed dynamically."""
    manager = SlidingWindowConversationManager(per_turn=False)
    registry = HookRegistry()
    manager.register_hooks(registry)

    mock_agent = MagicMock()
    mock_agent.messages = []
    event = BeforeModelCallEvent(agent=mock_agent, invocation_state={})

    # Initially disabled
    with patch.object(manager, "apply_management") as mock_apply:
        registry.invoke_callbacks(event)
        assert mock_apply.call_count == 0

    # Enable dynamically
    manager.per_turn = True
    with patch.object(manager, "apply_management") as mock_apply:
        registry.invoke_callbacks(event)
        assert mock_apply.call_count == 1


def test_per_turn_reduces_message_count():
    """Test that per_turn actually reduces message count during execution."""
    manager = SlidingWindowConversationManager(per_turn=1, window_size=4)
    responses = [{"role": "assistant", "content": [{"text": f"Response {i}"}]} for i in range(10)]
    model = MockedModelProvider(responses)
    agent = Agent(model=model, conversation_manager=manager)

    message_counts = []
    original_apply = manager.apply_management

    def track_apply(agent_instance):
        message_counts.append(len(agent_instance.messages))
        return original_apply(agent_instance)

    with patch.object(manager, "apply_management", side_effect=track_apply):
        agent("Test")

    # Verify message count stayed around window_size
    assert any(count <= manager.window_size for count in message_counts)


def test_per_turn_state_persistence():
    """Test that model_call_count is persisted in state."""
    manager = SlidingWindowConversationManager(per_turn=3)
    manager._model_call_count = 7

    state = manager.get_state()
    assert state["model_call_count"] == 7

    new_manager = SlidingWindowConversationManager(per_turn=3)
    new_manager.restore_from_session(state)
    assert new_manager._model_call_count == 7


def test_per_turn_backward_compatibility():
    """Test that existing code without per_turn still works."""
    manager = SlidingWindowConversationManager(window_size=40)
    assert manager.per_turn is False

    responses = [{"role": "assistant", "content": [{"text": "Hello"}]}]
    model = MockedModelProvider(responses)
    agent = Agent(model=model, conversation_manager=manager)
    result = agent("Hello")
    assert result is not None


# ==============================================================================
# Improved Truncation Strategy Tests
# ==============================================================================


def test_truncation_targets_oldest_message_first():
    """Oldest message with tool results is truncated before newer ones."""
    large_text = "X" * 20000
    manager = SlidingWindowConversationManager(window_size=10)
    messages = [
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": large_text}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "2", "name": "tool2", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "2", "content": [{"text": large_text}], "status": "success"}}],
        },
    ]
    test_agent = Agent(messages=messages)

    manager.reduce_context(test_agent, e=RuntimeError("context overflow"))

    # The oldest tool result (index 1) must be truncated
    oldest_text = messages[1]["content"][0]["toolResult"]["content"][0]["text"]
    assert "... [truncated:" in oldest_text

    # The newest tool result (index 3) must remain untouched after the first reduce_context call
    newest_text = messages[3]["content"][0]["toolResult"]["content"][0]["text"]
    assert "... [truncated:" not in newest_text


def test_truncation_skips_small_older_results_and_truncates_newer_large_result():
    """A small oldest tool result must not stop truncation of a newer large one; no messages are trimmed (#4341)."""
    large_text = "X" * 20000
    manager = SlidingWindowConversationManager(window_size=40)
    messages = [
        {"role": "user", "content": [{"text": "hi"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": "OK"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "2", "name": "tool2", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "2", "content": [{"text": large_text}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"text": "done"}]},
    ]
    test_agent = Agent(messages=messages)

    manager.reduce_context(test_agent, e=RuntimeError("context overflow"))

    assert len(messages) == 6
    assert manager.removed_message_count == 0
    assert messages[2]["content"][0]["toolResult"]["content"][0]["text"] == "OK"
    assert "... [truncated:" in messages[4]["content"][0]["toolResult"]["content"][0]["text"]


def test_truncation_moves_to_next_message_once_oldest_is_already_truncated():
    """Repeated overflows truncate the next untruncated tool result before falling back to trimming (#4341)."""
    large_text = "X" * 20000
    manager = SlidingWindowConversationManager(window_size=40)
    messages = [
        {"role": "user", "content": [{"text": "hi"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": large_text}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "2", "name": "tool2", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "2", "content": [{"text": large_text}], "status": "success"}}],
        },
    ]
    test_agent = Agent(messages=messages)

    manager.reduce_context(test_agent, e=RuntimeError("context overflow"))
    manager.reduce_context(test_agent, e=RuntimeError("context overflow"))

    assert len(messages) == 5
    assert manager.removed_message_count == 0
    assert "... [truncated:" in messages[2]["content"][0]["toolResult"]["content"][0]["text"]
    assert "... [truncated:" in messages[4]["content"][0]["toolResult"]["content"][0]["text"]


def test_large_tool_result_partially_truncated_with_context_preserved():
    """Large tool results are truncated in the middle while the beginning and end are preserved."""
    preserve = 200  # matches _PRESERVE_CHARS
    # Build text with distinct prefix, middle, and suffix
    prefix_text = "P" * preserve
    middle_text = "M" * 500
    suffix_text = "S" * preserve
    large_text = prefix_text + middle_text + suffix_text

    manager = SlidingWindowConversationManager(window_size=10)
    messages = [
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": large_text}], "status": "success"}}],
        }
    ]

    truncated = manager._truncate_tool_results(messages, 0)

    assert truncated
    result_text = messages[0]["content"][0]["toolResult"]["content"][0]["text"]
    assert result_text.startswith(prefix_text)
    assert result_text.endswith(suffix_text)
    assert "... [truncated:" in result_text
    removed = len(large_text) - 2 * preserve
    assert f"... [truncated: {removed} chars removed] ..." in result_text


def test_truncation_does_not_change_status_to_error():
    """Partial truncation must not change the tool result status."""
    large_text = "Z" * 15000
    manager = SlidingWindowConversationManager(window_size=10)
    messages = [
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": large_text}], "status": "success"}}],
        }
    ]

    manager._truncate_tool_results(messages, 0)

    assert messages[0]["content"][0]["toolResult"]["status"] == "success"


def test_image_blocks_inside_tool_result_replaced_with_placeholder():
    """Image blocks nested inside toolResult content are replaced with a text placeholder."""
    manager = SlidingWindowConversationManager(window_size=10)
    image_data = b"base64encodeddata"
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "1",
                        "content": [
                            {"text": "some text"},
                            {
                                "image": {
                                    "format": "jpeg",
                                    "source": {"bytes": image_data},
                                }
                            },
                        ],
                        "status": "success",
                    }
                }
            ],
        }
    ]

    changed = manager._truncate_tool_results(messages, 0)

    assert changed
    tool_result_items = messages[0]["content"][0]["toolResult"]["content"]
    assert not any(isinstance(item, dict) and "image" in item for item in tool_result_items)
    expected_placeholder = f"[image: jpeg, {len(image_data)} bytes]"
    assert any(isinstance(item, dict) and item.get("text") == expected_placeholder for item in tool_result_items)


def test_already_truncated_text_not_truncated_again():
    """A text block that already contains the truncation marker is not truncated a second time."""
    manager = SlidingWindowConversationManager(window_size=10)
    already_truncated = "A" * 200 + "...\n\n... [truncated: 990 chars removed] ...\n\n..." + "Z" * 200
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "1",
                        "content": [{"text": already_truncated}],
                        "status": "success",
                    }
                }
            ],
        }
    ]

    changed = manager._truncate_tool_results(messages, 0)

    assert not changed
    assert messages[0]["content"][0]["toolResult"]["content"][0]["text"] == already_truncated


def test_short_text_in_tool_result_not_truncated():
    """Text no longer than 2 * _PRESERVE_CHARS must not be modified."""
    manager = SlidingWindowConversationManager(window_size=10)
    short_text = "X" * 100  # 100 < 2 * 200
    messages = [
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": short_text}], "status": "success"}}],
        }
    ]

    changed = manager._truncate_tool_results(messages, 0)

    assert not changed
    assert messages[0]["content"][0]["toolResult"]["content"][0]["text"] == short_text


def test_boundary_text_in_tool_result_not_truncated():
    """Text of exactly 2 * _PRESERVE_CHARS must not be truncated."""
    manager = SlidingWindowConversationManager(window_size=10)
    boundary_text = "X" * 400  # exactly 2 * 200
    messages = [
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "1", "content": [{"text": boundary_text}], "status": "success"}}],
        }
    ]

    changed = manager._truncate_tool_results(messages, 0)

    assert not changed
    assert messages[0]["content"][0]["toolResult"]["content"][0]["text"] == boundary_text


# ==============================================================================
# window_size=0 and negative window_size validation tests
# ==============================================================================


def test_window_size_negative_raises_value_error():
    with pytest.raises(ValueError, match="window_size"):
        SlidingWindowConversationManager(window_size=-1)


def test_window_size_zero_clears_all_messages_on_apply_management():
    """window_size=0 should remove all messages, matching TypeScript SDK behaviour (issue #2205)."""
    manager = SlidingWindowConversationManager(window_size=0, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there"}]},
    ]
    test_agent = Agent(messages=messages)
    manager.apply_management(test_agent)

    assert messages == []
    assert manager.removed_message_count == 2


def test_window_size_zero_clears_all_messages_on_reduce_context():
    """reduce_context with window_size=0 should clear all messages even without overflow."""
    manager = SlidingWindowConversationManager(window_size=0, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "First"}]},
        {"role": "assistant", "content": [{"text": "Second"}]},
        {"role": "user", "content": [{"text": "Third"}]},
    ]
    test_agent = Agent(messages=messages)
    manager.reduce_context(test_agent)

    assert messages == []
    assert manager.removed_message_count == 3


def test_window_size_zero_clears_on_overflow():
    """reduce_context with window_size=0 should clear messages even when called with an overflow exception."""
    manager = SlidingWindowConversationManager(window_size=0, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi"}]},
    ]
    test_agent = Agent(messages=messages)
    manager.reduce_context(test_agent, e=Exception("overflow"))

    assert messages == []


# ==============================================================================
# Proactive Compression Tests (proactive_compression parameter)
# ==============================================================================


class _MinimalManager(ConversationManager):
    """Manager that only implements abstract methods."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.reduce_context_call_count = 0

    def apply_management(self, agent, **kwargs):
        pass

    def reduce_context(self, agent, e=None, **kwargs):
        self.reduce_context_call_count += 1
        if agent.messages:
            agent.messages.pop(0)


def _make_mock_agent(messages=None, context_window_limit=1000):
    agent = MagicMock()
    agent.messages = messages if messages is not None else []
    agent.model = MagicMock()
    agent.model.context_window_limit = context_window_limit
    agent.model._utilization_limit_warned = False
    agent.model.estimate_utilization = lambda input_tokens: Model.estimate_utilization(agent.model, input_tokens)
    return agent


def _make_threshold_event(agent, projected_input_tokens=None):
    return BeforeModelCallEvent(
        agent=agent,
        invocation_state={},
        projected_input_tokens=projected_input_tokens,
    )


def test_proactive_compression_rejects_zero():
    with pytest.raises(ValueError, match="compression_threshold must be between 0"):
        _MinimalManager(proactive_compression={"compression_threshold": 0})


def test_proactive_compression_rejects_negative():
    with pytest.raises(ValueError, match="compression_threshold must be between 0"):
        _MinimalManager(proactive_compression={"compression_threshold": -0.5})


def test_proactive_compression_rejects_greater_than_one():
    with pytest.raises(ValueError, match="compression_threshold must be between 0"):
        _MinimalManager(proactive_compression={"compression_threshold": 1.5})


def test_proactive_compression_accepts_exactly_one():
    manager = _MinimalManager(proactive_compression={"compression_threshold": 1.0})
    assert manager._compression_threshold == 1.0


def test_proactive_compression_none_by_default():
    manager = _MinimalManager()
    assert manager._compression_threshold is None


def test_proactive_compression_true_uses_default_threshold():
    """proactive_compression=True uses default threshold of 0.7."""
    manager = _MinimalManager(proactive_compression=True)
    assert manager._compression_threshold == 0.7


def test_proactive_compression_false_disables():
    """proactive_compression=False means no compression."""
    manager = _MinimalManager(proactive_compression=False)
    assert manager._compression_threshold is None


def test_proactive_compression_always_registers_hook():
    """Hook is always registered regardless of proactive_compression setting."""
    manager = _MinimalManager()
    registry = HookRegistry()
    manager.register_hooks(registry)
    # Always registers the hook
    assert registry.has_callbacks()


def test_proactive_compression_hook_is_noop_when_not_configured():
    """BeforeModelCallEvent handler is a no-op when proactive_compression is not set."""
    manager = _MinimalManager()
    agent = _make_mock_agent(context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=900)
    registry.invoke_callbacks(event)

    assert manager.reduce_context_call_count == 0


def test_proactive_compression_calls_reduce_context_when_exceeded():
    manager = _MinimalManager(proactive_compression={"compression_threshold": 0.7})
    agent = _make_mock_agent(messages=[{"role": "user", "content": [{"text": "msg"}]}], context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=800)
    registry.invoke_callbacks(event)

    assert manager.reduce_context_call_count == 1


def test_proactive_compression_no_call_when_below():
    manager = _MinimalManager(proactive_compression={"compression_threshold": 0.7})
    agent = _make_mock_agent(context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=500)
    registry.invoke_callbacks(event)

    assert manager.reduce_context_call_count == 0


def test_proactive_compression_no_call_when_projected_tokens_none():
    manager = _MinimalManager(proactive_compression=True)
    agent = _make_mock_agent(context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=None)
    registry.invoke_callbacks(event)

    assert manager.reduce_context_call_count == 0


def test_proactive_compression_uses_default_when_context_window_limit_not_set():
    manager = _MinimalManager(proactive_compression={"compression_threshold": 0.7})
    agent = _make_mock_agent(context_window_limit=None)
    registry = HookRegistry()
    manager.register_hooks(registry)

    # projected_input_tokens=150_000 is 75% of the 200k default, exceeding 0.7 threshold
    event = _make_threshold_event(agent, projected_input_tokens=150_000)
    with patch("strands.models.model.logger") as mock_logger:
        registry.invoke_callbacks(event)
        mock_logger.warning.assert_called_once()
        assert "using default" in mock_logger.warning.call_args[0][0]

    assert manager.reduce_context_call_count == 1


def test_proactive_compression_warns_only_once_per_instance():
    """Second invocation on the same manager instance suppresses the context_window_limit warning."""
    manager = _MinimalManager(proactive_compression={"compression_threshold": 0.7})
    agent = _make_mock_agent(context_window_limit=None)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=150_000)
    with patch("strands.models.model.logger") as mock_logger:
        registry.invoke_callbacks(event)
        registry.invoke_callbacks(event)
        assert mock_logger.warning.call_count == 1


def test_proactive_compression_exception_swallowed():
    """Exceptions in reduce_context during proactive compression should not propagate."""

    class _FailingManager(ConversationManager):
        def apply_management(self, agent, **kwargs):
            pass

        def reduce_context(self, agent, e=None, **kwargs):
            raise RuntimeError("boom")

    manager = _FailingManager(proactive_compression={"compression_threshold": 0.7})
    agent = _make_mock_agent(context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=800)
    registry.invoke_callbacks(event)


def test_proactive_compression_true_default_threshold_behavior():
    """proactive_compression=True uses 0.7 — triggered at 0.7+ but not below."""
    manager = _MinimalManager(proactive_compression=True)
    agent = _make_mock_agent(messages=[{"role": "user", "content": [{"text": "msg"}]}], context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    # 650/1000 = 0.65 < 0.7 — should NOT trigger
    event = _make_threshold_event(agent, projected_input_tokens=650)
    registry.invoke_callbacks(event)
    assert manager.reduce_context_call_count == 0

    # 800/1000 = 0.8 >= 0.7 — should trigger
    event2 = _make_threshold_event(agent, projected_input_tokens=800)
    registry.invoke_callbacks(event2)
    assert manager.reduce_context_call_count == 1


def test_sliding_window_proactive_compression_trims():
    manager = SlidingWindowConversationManager(
        window_size=4, should_truncate_results=False, proactive_compression={"compression_threshold": 0.7}
    )
    messages = [
        {"role": "user", "content": [{"text": f"Message {i}"}]}
        if i % 2 == 0
        else {"role": "assistant", "content": [{"text": f"Response {i}"}]}
        for i in range(6)
    ]
    agent = _make_mock_agent(messages=messages, context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=800)
    registry.invoke_callbacks(event)

    assert len(agent.messages) == 4


def test_sliding_window_proactive_compression_no_trim_below():
    manager = SlidingWindowConversationManager(
        window_size=4, should_truncate_results=False, proactive_compression={"compression_threshold": 0.7}
    )
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi"}]},
    ]
    agent = _make_mock_agent(messages=messages, context_window_limit=1000)
    registry = HookRegistry()
    manager.register_hooks(registry)

    event = _make_threshold_event(agent, projected_input_tokens=500)
    registry.invoke_callbacks(event)

    assert len(agent.messages) == 2


# --- pin_first tests ---


def test_pin_first_protects_first_n_messages_from_trimming():
    manager = SlidingWindowConversationManager(window_size=2, should_truncate_results=False, pin_first=2)
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "second"}]},
        {"role": "user", "content": [{"text": "third"}]},
        {"role": "assistant", "content": [{"text": "fourth"}]},
        {"role": "user", "content": [{"text": "fifth"}]},
        {"role": "assistant", "content": [{"text": "sixth"}]},
    ]
    agent = _make_mock_agent(messages=messages)
    manager.reduce_context(agent)

    texts = [m["content"][0]["text"] for m in agent.messages]
    assert "first" in texts
    assert "second" in texts
    assert "third" not in texts
    assert "fourth" not in texts


def test_pin_first_returns_without_trimming_when_all_in_range_are_pinned():
    manager = SlidingWindowConversationManager(window_size=2, should_truncate_results=False, pin_first=4)
    messages = [
        {"role": "user", "content": [{"text": "a"}]},
        {"role": "assistant", "content": [{"text": "b"}]},
        {"role": "user", "content": [{"text": "c"}]},
        {"role": "assistant", "content": [{"text": "d"}]},
    ]
    agent = _make_mock_agent(messages=messages)
    manager.reduce_context(agent)

    assert len(agent.messages) == 4


def test_pin_first_with_window_size_zero_preserves_pinned():
    manager = SlidingWindowConversationManager(window_size=0, should_truncate_results=False, pin_first=2)
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "second"}]},
        {"role": "user", "content": [{"text": "third"}]},
        {"role": "assistant", "content": [{"text": "fourth"}]},
    ]
    agent = _make_mock_agent(messages=messages)
    manager.reduce_context(agent)

    texts = [m["content"][0]["text"] for m in agent.messages]
    assert texts == ["first", "second"]


def test_pin_first_only_applies_once():
    manager = SlidingWindowConversationManager(window_size=4, should_truncate_results=False, pin_first=2)
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "second"}]},
        {"role": "user", "content": [{"text": "third"}]},
        {"role": "assistant", "content": [{"text": "fourth"}]},
        {"role": "user", "content": [{"text": "fifth"}]},
        {"role": "assistant", "content": [{"text": "sixth"}]},
    ]
    agent = _make_mock_agent(messages=messages)

    # First reduction
    manager.reduce_context(agent)
    # Verify pin was applied
    assert agent.messages[0].get("metadata", {}).get("custom", {}).get("pinned") is True

    # Second reduction — should not re-apply (flag is set)
    agent.messages.extend(
        [
            {"role": "user", "content": [{"text": "seventh"}]},
            {"role": "assistant", "content": [{"text": "eighth"}]},
        ]
    )
    manager.reduce_context(agent)
    # Still works without error
    assert "first" in [m["content"][0]["text"] for m in agent.messages]


def test_pinned_message_in_middle_survives_trimming():
    from strands.agent.conversation_manager.compression.pin_message import pin_message

    manager = SlidingWindowConversationManager(window_size=4, should_truncate_results=False)
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "second"}]},
        {"role": "user", "content": [{"text": "pinned-middle"}]},
        {"role": "assistant", "content": [{"text": "fourth"}]},
        {"role": "user", "content": [{"text": "fifth"}]},
        {"role": "assistant", "content": [{"text": "sixth"}]},
    ]
    pin_message(messages, 2)
    agent = _make_mock_agent(messages=messages)
    manager.reduce_context(agent)

    texts = [m["content"][0]["text"] for m in agent.messages]
    assert "pinned-middle" in texts
    assert "first" not in texts
