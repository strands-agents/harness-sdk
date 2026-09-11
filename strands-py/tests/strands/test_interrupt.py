import pytest

from strands.interrupt import _AGENT_STREAM_INTERRUPT_ID_PREFIX, Interrupt, PendingToolExecution, _InterruptState
from strands.types.exceptions import SessionException


@pytest.fixture
def interrupt():
    return Interrupt(
        id="test_id:test_name",
        name="test_name",
        reason={"reason": "test"},
        response={"response": "test"},
    )


def test_interrupt_to_dict(interrupt):
    tru_dict = interrupt.to_dict()
    exp_dict = {
        "id": "test_id:test_name",
        "name": "test_name",
        "reason": {"reason": "test"},
        "response": {"response": "test"},
    }
    assert tru_dict == exp_dict


def test_interrupt_state_activate():
    interrupt_state = _InterruptState()

    interrupt_state.activate()
    assert interrupt_state.activated


def test_interrupt_state_deactivate():
    interrupt_state = _InterruptState(
        context={"test": "context"},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[],
        ),
    )

    interrupt_state.deactivate()

    assert not interrupt_state.activated

    tru_context = interrupt_state.context
    exp_context = {}
    assert tru_context == exp_context
    assert interrupt_state.pending_tool_execution is None


def test_interrupt_state_to_dict():
    interrupt_state = _InterruptState(
        interrupts={"test_id": Interrupt(id="test_id", name="test_name", reason="test reason")},
        context={"test": "context"},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[{"toolUseId": "tool-1", "status": "success", "content": []}],
        ),
    )

    tru_data = interrupt_state.to_dict()
    exp_data = {
        "interrupts": {"test_id": {"id": "test_id", "name": "test_name", "reason": "test reason", "response": None}},
        "context": {"test": "context"},
        "activated": True,
        "pending_tool_execution": {
            "assistant_message": {"role": "assistant", "content": []},
            "completed_tool_results": [{"toolUseId": "tool-1", "status": "success", "content": []}],
        },
    }
    assert tru_data == exp_data


def test_interrupt_state_from_dict():
    data = {
        "interrupts": {"test_id": {"id": "test_id", "name": "test_name", "reason": "test reason", "response": None}},
        "context": {"test": "context", "tool_results": ["unrelated"]},
        "activated": True,
        "pending_tool_execution": {
            "assistant_message": {"role": "assistant", "content": []},
            "completed_tool_results": [{"toolUseId": "tool-1", "status": "success", "content": []}],
        },
    }

    tru_state = _InterruptState.from_dict(data)
    exp_state = _InterruptState(
        interrupts={"test_id": Interrupt(id="test_id", name="test_name", reason="test reason")},
        context={"test": "context", "tool_results": ["unrelated"]},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[{"toolUseId": "tool-1", "status": "success", "content": []}],
        ),
    )
    assert tru_state == exp_state


def test_interrupt_state_from_dict_migrates_legacy_tool_context():
    prompt = [{"interruptResponse": {"interruptId": "test_id", "response": "approved"}}]
    data = {
        "interrupts": {},
        "context": {
            "responses": prompt,
            "tool_use_message": {"role": "assistant", "content": []},
            "tool_results": [{"toolUseId": "tool-1", "status": "success", "content": []}],
        },
        "activated": True,
    }

    tru_state = _InterruptState.from_dict(data)
    exp_state = _InterruptState(
        context={"responses": prompt},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[{"toolUseId": "tool-1", "status": "success", "content": []}],
        ),
    )
    assert tru_state == exp_state
    assert data["context"] == {
        "responses": prompt,
        "tool_use_message": {"role": "assistant", "content": []},
        "tool_results": [{"toolUseId": "tool-1", "status": "success", "content": []}],
    }


def test_interrupt_state_from_dict_prefers_typed_pending_execution_over_legacy_context():
    data = {
        "interrupts": {},
        "context": {
            "responses": [],
            "tool_use_message": {"role": "assistant", "content": [{"text": "legacy"}]},
            "tool_results": [{"toolUseId": "legacy", "status": "success", "content": []}],
        },
        "activated": True,
        "pending_tool_execution": {
            "assistant_message": {"role": "assistant", "content": [{"text": "typed"}]},
            "completed_tool_results": [{"toolUseId": "typed", "status": "success", "content": []}],
        },
    }

    tru_state = _InterruptState.from_dict(data)
    exp_state = _InterruptState(
        context={"responses": []},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": [{"text": "typed"}]},
            completed_tool_results=[{"toolUseId": "typed", "status": "success", "content": []}],
        ),
    )
    assert tru_state == exp_state
    assert data["context"] == {
        "responses": [],
        "tool_use_message": {"role": "assistant", "content": [{"text": "legacy"}]},
        "tool_results": [{"toolUseId": "legacy", "status": "success", "content": []}],
    }


def test_interrupt_state_pending_tool_execution_round_trip_is_independent():
    interrupt_state = _InterruptState(
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": [{"text": "pending"}]},
            completed_tool_results=[{"toolUseId": "tool-1", "status": "success", "content": []}],
        ),
    )

    serialized_state = interrupt_state.to_dict()
    tru_state = _InterruptState.from_dict(serialized_state)
    exp_state = interrupt_state
    assert tru_state == exp_state

    serialized_state["pending_tool_execution"]["completed_tool_results"][0]["status"] = "error"
    exp_pending_tool_execution = PendingToolExecution(
        assistant_message={"role": "assistant", "content": [{"text": "pending"}]},
        completed_tool_results=[{"toolUseId": "tool-1", "status": "success", "content": []}],
    )
    assert interrupt_state.pending_tool_execution == exp_pending_tool_execution


def test_interrupt_state_from_dict_wraps_invalid_pending_tool_execution():
    data = {
        "interrupts": {},
        "context": {},
        "activated": True,
        "pending_tool_execution": {"assistant_message": {"role": "assistant", "content": []}},
    }

    with pytest.raises(SessionException, match="Failed to restore pending tool execution state") as error_info:
        _InterruptState.from_dict(data)

    assert isinstance(error_info.value.__cause__, TypeError)


def test_interrupt_state_resume():
    interrupt_state = _InterruptState(
        interrupts={"test_id": Interrupt(id="test_id", name="test_name", reason="test reason")},
        activated=True,
    )

    prompt = [
        {
            "interruptResponse": {
                "interruptId": "test_id",
                "response": "test response",
            }
        }
    ]
    interrupt_state.resume(prompt)

    tru_response = interrupt_state.interrupts["test_id"].response
    exp_response = "test response"
    assert tru_response == exp_response

    tru_context = interrupt_state.context
    exp_context = {"responses": prompt}
    assert tru_context == exp_context


def test_interrupt_state_resumse_deactivated():
    interrupt_state = _InterruptState(activated=False)
    interrupt_state.resume([])


def test_interrupt_state_resume_invalid_prompt():
    interrupt_state = _InterruptState(activated=True)

    exp_message = r"prompt_type=<class 'str'> \| must resume from interrupt with list of interruptResponse's"
    with pytest.raises(TypeError, match=exp_message):
        interrupt_state.resume("invalid")


def test_interrupt_state_resume_invalid_content():
    interrupt_state = _InterruptState(activated=True)

    exp_message = r"content_types=<\['text'\]> \| must resume from interrupt with list of interruptResponse's"
    with pytest.raises(TypeError, match=exp_message):
        interrupt_state.resume([{"text": "invalid"}])


def test_interrupt_resume_invalid_id():
    interrupt_state = _InterruptState(activated=True)

    exp_message = r"interrupt_id=<invalid> \| no interrupt found"
    with pytest.raises(KeyError, match=exp_message):
        interrupt_state.resume([{"interruptResponse": {"interruptId": "invalid", "response": None}}])


# ============================================================================
# Version Tracking Tests
# ============================================================================


def test_interrupt_state_version_is_zero_after_initialization():
    """Test that _get_version() returns 0 after initialization."""
    interrupt_state = _InterruptState()
    assert interrupt_state._get_version() == 0


def test_interrupt_state_version_increments_after_activate():
    """Test that _get_version() increments after activate() is called."""
    interrupt_state = _InterruptState()
    assert interrupt_state._get_version() == 0

    interrupt_state.activate()
    assert interrupt_state._get_version() == 1


def test_interrupt_state_version_increments_after_deactivate():
    """Test that _get_version() increments after deactivate() is called."""
    interrupt_state = _InterruptState(activated=True)
    initial_version = interrupt_state._get_version()

    interrupt_state.deactivate()
    assert interrupt_state._get_version() == initial_version + 1


def test_interrupt_state_version_increments_after_resume():
    """Test that _get_version() increments after resume() is called."""
    interrupt_state = _InterruptState(
        interrupts={"test_id": Interrupt(id="test_id", name="test_name", reason="test reason")},
        activated=True,
    )
    initial_version = interrupt_state._get_version()

    prompt = [{"interruptResponse": {"interruptId": "test_id", "response": "test response"}}]
    interrupt_state.resume(prompt)
    assert interrupt_state._get_version() == initial_version + 1


def test_interrupt_state_set_pending_tool_results_increments_version():
    interrupt_state = _InterruptState(
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[],
        )
    )
    initial_version = interrupt_state._get_version()
    completed_tool_results = [{"toolUseId": "tool-1", "status": "success", "content": []}]

    interrupt_state.set_pending_tool_results(completed_tool_results)

    tru_pending_tool_execution = interrupt_state.pending_tool_execution
    exp_pending_tool_execution = PendingToolExecution(
        assistant_message={"role": "assistant", "content": []},
        completed_tool_results=completed_tool_results,
    )
    assert tru_pending_tool_execution == exp_pending_tool_execution
    assert interrupt_state._get_version() == initial_version + 1


def test_interrupt_state_version_increments_independently():
    """Test that version increments independently for each operation."""
    interrupt_state = _InterruptState()
    assert interrupt_state._get_version() == 0

    interrupt_state.activate()
    assert interrupt_state._get_version() == 1

    interrupt_state.deactivate()
    assert interrupt_state._get_version() == 2


def test_interrupt_state_version_not_in_to_dict():
    """Test that _version is not included in to_dict() output."""
    interrupt_state = _InterruptState()
    interrupt_state.activate()

    data = interrupt_state.to_dict()
    assert "_version" not in data
    assert "version" not in data


def test_interrupt_state_end_tool_cycle():
    """Answered agent-stream interrupts outlive a tool cycle; everything else is cleared."""
    answered_gate = Interrupt(id=f"{_AGENT_STREAM_INTERRUPT_ID_PREFIX}answered", name="gate", response="approved")
    unanswered_gate = Interrupt(id=f"{_AGENT_STREAM_INTERRUPT_ID_PREFIX}unanswered", name="gate2")
    tool_interrupt = Interrupt(id="v1:tool_call:t1:abc", name="tool_gate", response="approved")
    interrupt_state = _InterruptState(
        interrupts={
            answered_gate.id: answered_gate,
            unanswered_gate.id: unanswered_gate,
            tool_interrupt.id: tool_interrupt,
        },
        context={"responses": []},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[],
        ),
    )

    interrupt_state.end_tool_cycle()

    tru_interrupts = interrupt_state.interrupts
    exp_interrupts = {answered_gate.id: answered_gate}
    assert tru_interrupts == exp_interrupts
    assert interrupt_state.context == {}
    assert not interrupt_state.activated
    assert interrupt_state.pending_tool_execution is None


def test_interrupt_state_end_interrupt_cycle():
    """Agent-stream interrupts are dropped; tool execution state and context are untouched."""
    answered_gate = Interrupt(id=f"{_AGENT_STREAM_INTERRUPT_ID_PREFIX}answered", name="gate", response="approved")
    tool_interrupt = Interrupt(id="v1:tool_call:t1:abc", name="tool_gate")
    interrupt_state = _InterruptState(
        interrupts={answered_gate.id: answered_gate, tool_interrupt.id: tool_interrupt},
        context={"responses": []},
        activated=True,
        pending_tool_execution=PendingToolExecution(
            assistant_message={"role": "assistant", "content": []},
            completed_tool_results=[],
        ),
    )

    interrupt_state.end_interrupt_cycle()

    tru_interrupts = interrupt_state.interrupts
    exp_interrupts = {tool_interrupt.id: tool_interrupt}
    assert tru_interrupts == exp_interrupts
    assert interrupt_state.context == {"responses": []}
    assert interrupt_state.activated
    assert interrupt_state.pending_tool_execution == PendingToolExecution(
        assistant_message={"role": "assistant", "content": []},
        completed_tool_results=[],
    )


def test_interrupt_state_end_interrupt_cycle_nothing_to_release():
    """With nothing to drop the state is left alone, version included."""
    tool_interrupt = Interrupt(id="v1:tool_call:t1:abc", name="tool_gate")
    interrupt_state = _InterruptState(interrupts={tool_interrupt.id: tool_interrupt})
    version = interrupt_state._get_version()

    interrupt_state.end_interrupt_cycle()

    assert interrupt_state.interrupts == {tool_interrupt.id: tool_interrupt}
    assert interrupt_state._get_version() == version


def test_interrupt_state_to_dict_omits_retained_invocation_scoped_responses():
    """A response retained while deactivated is readable only in-pass, so it is never serialized."""
    retained = Interrupt(id=f"{_AGENT_STREAM_INTERRUPT_ID_PREFIX}retained", name="gate", response="approved")
    tool_interrupt = Interrupt(id="v1:tool_call:t1:abc", name="tool_gate", response="approved")
    interrupt_state = _InterruptState(
        interrupts={retained.id: retained, tool_interrupt.id: tool_interrupt},
        activated=False,
    )

    tru_interrupts = interrupt_state.to_dict()["interrupts"]
    exp_interrupts = {tool_interrupt.id: tool_interrupt.to_dict()}
    assert tru_interrupts == exp_interrupts

    # While activated the caller is owed a resume, so everything is serialized.
    interrupt_state.activate()
    assert set(interrupt_state.to_dict()["interrupts"]) == {retained.id, tool_interrupt.id}


def test_interrupt_state_from_dict_drops_retained_invocation_scoped_responses():
    """A session written before responses stopped being serialized does not revive an approval."""
    retained = Interrupt(id=f"{_AGENT_STREAM_INTERRUPT_ID_PREFIX}retained", name="gate", response="approved")
    data = {"interrupts": {retained.id: retained.to_dict()}, "context": {}, "activated": False}

    assert _InterruptState.from_dict(data).interrupts == {}

    data["activated"] = True
    assert set(_InterruptState.from_dict(data).interrupts) == {retained.id}
