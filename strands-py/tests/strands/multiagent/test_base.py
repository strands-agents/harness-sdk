import pytest

from strands.agent import AgentResult
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status


@pytest.fixture
def agent_result():
    """Create a mock AgentResult for testing."""
    return AgentResult(
        message={"role": "assistant", "content": [{"text": "Test response"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )


def test_node_result_initialization_and_properties(agent_result):
    """Test NodeResult initialization and property access."""
    # Basic initialization
    node_result = NodeResult(result=agent_result, execution_time=50, status="completed")

    # Verify properties
    assert node_result.result == agent_result
    assert node_result.execution_time == 50
    assert node_result.status == "completed"
    assert node_result.accumulated_usage == {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    assert node_result.accumulated_metrics == {"latencyMs": 0.0}
    assert node_result.execution_count == 0

    default_node = NodeResult(result=agent_result)
    assert default_node.status == Status.PENDING

    # With custom metrics
    custom_usage = {"inputTokens": 100, "outputTokens": 200, "totalTokens": 300}
    custom_metrics = {"latencyMs": 250.0}
    node_result_custom = NodeResult(
        result=agent_result,
        execution_time=75,
        status="completed",
        accumulated_usage=custom_usage,
        accumulated_metrics=custom_metrics,
        execution_count=5,
    )
    assert node_result_custom.accumulated_usage == custom_usage
    assert node_result_custom.accumulated_metrics == custom_metrics
    assert node_result_custom.execution_count == 5

    # Test default factory creates independent instances
    node_result1 = NodeResult(result=agent_result)
    node_result2 = NodeResult(result=agent_result)
    node_result1.accumulated_usage["inputTokens"] = 100
    assert node_result2.accumulated_usage["inputTokens"] == 0
    assert node_result1.accumulated_usage is not node_result2.accumulated_usage


def test_node_result_get_agent_results(agent_result):
    """Test get_agent_results method with different structures."""
    # Simple case with single AgentResult
    node_result = NodeResult(result=agent_result)
    agent_results = node_result.get_agent_results()
    assert len(agent_results) == 1
    assert agent_results[0] == agent_result

    # Test with Exception as result (should return empty list)
    exception_result = NodeResult(result=Exception("Test exception"), status=Status.FAILED)
    agent_results = exception_result.get_agent_results()
    assert len(agent_results) == 0

    # Complex nested case
    inner_agent_result1 = AgentResult(
        message={"role": "assistant", "content": [{"text": "Response 1"}]}, stop_reason="end_turn", state={}, metrics={}
    )
    inner_agent_result2 = AgentResult(
        message={"role": "assistant", "content": [{"text": "Response 2"}]}, stop_reason="end_turn", state={}, metrics={}
    )

    inner_node_result1 = NodeResult(result=inner_agent_result1)
    inner_node_result2 = NodeResult(result=inner_agent_result2)

    multi_agent_result = MultiAgentResult(results={"node1": inner_node_result1, "node2": inner_node_result2})

    outer_node_result = NodeResult(result=multi_agent_result)
    agent_results = outer_node_result.get_agent_results()

    assert len(agent_results) == 2
    response_texts = [result.message["content"][0]["text"] for result in agent_results]
    assert "Response 1" in response_texts
    assert "Response 2" in response_texts


def test_multi_agent_result_initialization(agent_result):
    """Test MultiAgentResult initialization with defaults and custom values."""
    # Default initialization
    result = MultiAgentResult(results={})
    assert result.results == {}
    assert result.accumulated_usage == {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    assert result.accumulated_metrics == {"latencyMs": 0.0}
    assert result.execution_count == 0
    assert result.execution_time == 0
    assert result.status == Status.PENDING

    # Custom values``
    node_result = NodeResult(result=agent_result)
    results = {"test_node": node_result}
    usage = {"inputTokens": 50, "outputTokens": 100, "totalTokens": 150}
    metrics = {"latencyMs": 200.0}

    result = MultiAgentResult(
        results=results, accumulated_usage=usage, accumulated_metrics=metrics, execution_count=3, execution_time=300
    )

    assert result.results == results
    assert result.accumulated_usage == usage
    assert result.accumulated_metrics == metrics
    assert result.execution_count == 3
    assert result.execution_time == 300

    # Test default factory creates independent instances
    result1 = MultiAgentResult(results={})
    result2 = MultiAgentResult(results={})
    result1.accumulated_usage["inputTokens"] = 200
    result1.accumulated_metrics["latencyMs"] = 500.0
    assert result2.accumulated_usage["inputTokens"] == 0
    assert result2.accumulated_metrics["latencyMs"] == 0.0
    assert result1.accumulated_usage is not result2.accumulated_usage
    assert result1.accumulated_metrics is not result2.accumulated_metrics


def test_multi_agent_base_abstract_behavior():
    """Test abstract class behavior of MultiAgentBase."""
    # Test that MultiAgentBase cannot be instantiated directly
    with pytest.raises(TypeError):
        MultiAgentBase()

    # Test that incomplete implementations raise TypeError
    class IncompleteMultiAgent(MultiAgentBase):
        pass

    with pytest.raises(TypeError):
        IncompleteMultiAgent()

    # Test that complete implementations can be instantiated
    class CompleteMultiAgent(MultiAgentBase):
        async def invoke_async(self, task: str) -> MultiAgentResult:
            return MultiAgentResult(results={})

        def serialize_state(self) -> dict:
            return {}

        def deserialize_state(self, payload: dict) -> None:
            pass

    # Should not raise an exception - __call__ is provided by base class
    agent = CompleteMultiAgent()
    assert isinstance(agent, MultiAgentBase)


@pytest.mark.filterwarnings("ignore:`\\*\\*kwargs` parameter is deprecating:UserWarning")
def test_multi_agent_base_call_method():
    """Test that __call__ method properly delegates to invoke_async."""

    class TestMultiAgent(MultiAgentBase):
        def __init__(self):
            self.invoke_async_called = False
            self.received_task = None
            self.received_kwargs = None

        async def invoke_async(self, task, invocation_state, **kwargs):
            self.invoke_async_called = True
            self.received_task = task
            self.received_kwargs = kwargs
            self.received_invocation_state = invocation_state
            return MultiAgentResult(
                status=Status.COMPLETED, results={"test": NodeResult(result=Exception("test"), status=Status.COMPLETED)}
            )

        def serialize_state(self) -> dict:
            return {}

        def deserialize_state(self, payload: dict) -> None:
            pass

    agent = TestMultiAgent()

    # Test with string task
    result = agent("test task", param1="value1", param2="value2", invocation_state={"value3": "value4"})

    assert agent.invoke_async_called
    assert agent.received_task == "test task"
    assert agent.received_invocation_state == {"param1": "value1", "param2": "value2", "value3": "value4"}
    assert isinstance(result, MultiAgentResult)
    assert result.status == Status.COMPLETED


def test_node_result_to_dict(agent_result):
    """Test NodeResult to_dict method."""
    node_result = NodeResult(result=agent_result, execution_time=100, status=Status.COMPLETED)
    result_dict = node_result.to_dict()

    assert result_dict["execution_time"] == 100
    assert result_dict["status"] == "completed"
    assert result_dict["result"]["type"] == "agent_result"
    assert result_dict["result"]["stop_reason"] == agent_result.stop_reason
    assert result_dict["result"]["message"] == agent_result.message

    exception_result = NodeResult(result=Exception("Test error"), status=Status.FAILED)
    result_dict = exception_result.to_dict()

    assert result_dict["result"]["type"] == "exception"
    assert result_dict["result"]["message"] == "Test error"
    assert result_dict["status"] == "failed"


def test_multi_agent_result_to_dict(agent_result):
    """Test MultiAgentResult to_dict method."""
    node_result = NodeResult(result=agent_result)
    multi_result = MultiAgentResult(status=Status.COMPLETED, results={"test_node": node_result}, execution_time=200)

    result_dict = multi_result.to_dict()

    assert result_dict["status"] == "completed"
    assert result_dict["execution_time"] == 200
    assert "test_node" in result_dict["results"]
    assert result_dict["results"]["test_node"]["result"]["type"] == "agent_result"


def test_serialize_node_result_for_persist(agent_result):
    """Test serialize_node_result_for_persist method."""

    node_result = NodeResult(result=agent_result)
    serialized = node_result.to_dict()

    assert "result" in serialized
    assert "execution_time" in serialized
    assert "status" in serialized

    exception_node_result = NodeResult(result=Exception("Test error"), status=Status.FAILED)
    serialized_exception = exception_node_result.to_dict()
    assert "result" in serialized_exception
    assert serialized_exception["result"]["type"] == "exception"
    assert serialized_exception["result"]["message"] == "Test error"


def test_node_result_str_with_agent_result():
    """Test NodeResult.__str__ delegates to AgentResult.__str__."""
    agent_result = AgentResult(
        message={"role": "assistant", "content": [{"text": "Hello world"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    node_result = NodeResult(result=agent_result)
    assert str(node_result) == str(agent_result)
    assert "Hello world" in str(node_result)


def test_node_result_str_with_exception():
    """Test NodeResult.__str__ with an Exception result."""
    node_result = NodeResult(result=Exception("something broke"), status=Status.FAILED)
    assert str(node_result) == "something broke"


def test_multi_agent_result_str_single_node(agent_result):
    """Test MultiAgentResult.__str__ with a single node."""
    result = MultiAgentResult(
        status=Status.COMPLETED,
        results={"writer": NodeResult(result=agent_result)},
    )
    output = str(result)
    assert "writer: Test response" in output


def test_multi_agent_result_str_with_interrupts():
    """Test MultiAgentResult.__str__ prioritizes interrupts over node results."""
    from strands.interrupt import Interrupt

    ar = AgentResult(
        message={"role": "assistant", "content": [{"text": "should not appear"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    result = MultiAgentResult(
        status=Status.INTERRUPTED,
        results={"node": NodeResult(result=ar)},
        interrupts=[Interrupt(id="int-1", name="approval", reason="needs review")],
    )
    output = str(result)
    assert "should not appear" not in output
    assert "approval" in output


def test_multi_agent_result_str_empty():
    """Test MultiAgentResult.__str__ with no results."""
    result = MultiAgentResult(status=Status.COMPLETED, results={})
    assert str(result) == ""


def test_multi_agent_result_str_skips_empty_node_strings():
    """Test MultiAgentResult.__str__ skips nodes whose string representation is empty."""
    # Create an AgentResult with empty content to produce empty string
    empty_ar = AgentResult(
        message={"role": "assistant", "content": []},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    non_empty_ar = AgentResult(
        message={"role": "assistant", "content": [{"text": "Has content"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    result = MultiAgentResult(
        status=Status.COMPLETED,
        results={
            "empty_node": NodeResult(result=empty_ar),
            "content_node": NodeResult(result=non_empty_ar),
        },
    )
    output = str(result)
    # The empty node should be skipped
    assert "empty_node" not in output
    # The non-empty node should appear
    assert "content_node: Has content" in output


def test_multi_agent_result_str_multiple_nodes():
    """Test MultiAgentResult.__str__ with multiple nodes."""
    ar1 = AgentResult(
        message={"role": "assistant", "content": [{"text": "Response 1"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    ar2 = AgentResult(
        message={"role": "assistant", "content": [{"text": "Response 2"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    result = MultiAgentResult(
        status=Status.COMPLETED,
        results={"node1": NodeResult(result=ar1), "node2": NodeResult(result=ar2)},
    )
    output = str(result)
    assert "node1: Response 1" in output
    assert "node2: Response 2" in output
    assert "\n" in output


def test_node_result_str_with_nested_multiagent():
    """Test NodeResult.__str__ with nested MultiAgentResult."""
    inner_ar = AgentResult(
        message={"role": "assistant", "content": [{"text": "Nested response"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    inner_mar = MultiAgentResult(
        status=Status.COMPLETED,
        results={"inner_node": NodeResult(result=inner_ar)},
    )
    outer_node = NodeResult(result=inner_mar)
    assert "inner_node: Nested response" in str(outer_node)


def test_multi_agent_result_str_preserves_payload_whitespace():
    """Regression test: MultiAgentResult.__str__ preserves user-owned whitespace.

    Verifies that only the framework-owned trailing newline (appended by
    AgentResult.__str__) is removed, while all user-owned whitespace is preserved:
    - Leading indentation (e.g., code blocks)
    - Internal markdown hard-break (two trailing spaces before newline)
    - Trailing newlines in the payload
    - Whitespace-only content is preserved if non-empty after removesuffix

    This test guards against regressing to .strip() which removes all whitespace.
    """
    # Content with: leading indentation, internal markdown hard-break (2 trailing spaces),
    # and explicit trailing newlines in the payload
    code_with_whitespace = "    def foo():\n        pass  \n\n"  # 4-space indent, 2-space hard-break

    ar_whitespace = AgentResult(
        message={"role": "assistant", "content": [{"text": code_with_whitespace}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )

    # Whitespace-only node (spaces only - should appear since it's non-empty after removesuffix)
    ar_spaces_only = AgentResult(
        message={"role": "assistant", "content": [{"text": "   "}]},  # 3 spaces
        stop_reason="end_turn",
        state={},
        metrics={},
    )

    # Nested MultiAgentResult with whitespace content
    inner_ar = AgentResult(
        message={"role": "assistant", "content": [{"text": "  nested indent\n"}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )
    inner_mar = MultiAgentResult(
        status=Status.COMPLETED,
        results={"inner": NodeResult(result=inner_ar)},
    )

    result = MultiAgentResult(
        status=Status.COMPLETED,
        results={
            "code_node": NodeResult(result=ar_whitespace),
            "spaces_node": NodeResult(result=ar_spaces_only),
            "nested_node": NodeResult(result=inner_mar),
        },
    )

    output = str(result)

    # Verify leading indentation preserved (would be stripped by .strip())
    assert "code_node:     def foo():" in output, "Leading indentation must be preserved"

    # Verify internal markdown hard-break (2 trailing spaces) preserved
    assert "pass  \n" in output, "Markdown hard-break (2 trailing spaces) must be preserved"

    # Verify trailing newlines in payload preserved (framework removes only 1)
    # The original text has "\n\n" at end, AgentResult adds one more "\n"
    # So AgentResult.__str__ produces "    def foo():\n        pass  \n\n\n"
    # After removesuffix("\n"), we get "    def foo():\n        pass  \n\n"
    assert output.count("pass  \n\n") == 1, "Payload trailing newlines must be preserved"

    # Verify whitespace-only node appears (3 spaces + newline from AgentResult -> 3 spaces after removesuffix)
    assert "spaces_node:    " in output, "Whitespace-only content must be preserved"

    # Verify nested result preserves whitespace
    assert "inner:   nested indent" in output, "Nested result must preserve leading spaces"


def test_multi_agent_result_str_whitespace_exact_output():
    """Exact-output test for whitespace handling in MultiAgentResult.__str__.

    This test asserts the exact output string to catch any subtle changes
    to whitespace handling. The framework separator (\n from AgentResult)
    should be removed, but all payload whitespace must be verbatim.
    """
    # Single text item with carefully controlled whitespace
    text = "  line1  \nline2\n"  # 2-space prefix, 2-space suffix on line1, trailing newline

    ar = AgentResult(
        message={"role": "assistant", "content": [{"text": text}]},
        stop_reason="end_turn",
        state={},
        metrics={},
    )

    result = MultiAgentResult(
        status=Status.COMPLETED,
        results={"node": NodeResult(result=ar)},
    )

    # AgentResult.__str__ produces "  line1  \nline2\n\n" (appends \n)
    # After removesuffix("\n"), we get "  line1  \nline2\n"
    expected = "node:   line1  \nline2\n"
    assert str(result) == expected, f"Expected exact output:\n{expected!r}\nGot:\n{str(result)!r}"
