"""Integration tests for agent checkpointing with Amazon Bedrock.

These tests exercise the V0 durable-execution contract: an agent with
``checkpointing=True`` pauses at ReAct cycle boundaries and returns an
``AgentResult`` with ``stop_reason="checkpoint"`` and a ``checkpoint`` field
carrying the pause-point marker. State persistence is the caller's job;
these tests pair checkpointing with ``FileSessionManager`` to demonstrate
the recommended pattern: SessionManager for state continuity, Checkpoint
for boundary signalling.

Requires valid AWS credentials and may incur API costs.

To run:
    hatch test tests_integ/test_agent_checkpoint.py
"""

import json
import os
from pathlib import Path

import pytest

from strands import Agent, tool
from strands.experimental.checkpoint import Checkpoint
from strands.models import BedrockModel
from strands.session import FileSessionManager

pytestmark = [
    pytest.mark.skipif(not os.getenv("AWS_REGION"), reason="AWS credentials not available"),
    pytest.mark.asyncio,
]

MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def _build_agent(tools: list, *, session_id: str, storage_dir: Path) -> Agent:
    """Build a checkpointing agent backed by FileSessionManager.

    SessionManager provides conversation continuity across fresh Agent
    instances; checkpointing provides the pause-point marker. Together
    they form the V0 durable-execution recommendation.
    """
    return Agent(
        model=BedrockModel(model_id=MODEL_ID),
        tools=tools,
        system_prompt=(
            "You are a helpful assistant. When a user asks a factual question, "
            "you MUST call the provided tools to answer. Do not answer from memory."
        ),
        session_manager=FileSessionManager(session_id=session_id, storage_dir=str(storage_dir)),
        checkpointing=True,
    )


async def _drive_to_completion(
    tools: list,
    first_prompt: str,
    *,
    session_id: str,
    storage_dir: Path,
    max_resumes: int = 10,
) -> tuple[Agent, list[Checkpoint]]:
    """Drive a checkpointing agent to end_turn across fresh Agent instances.

    Each pause: serialize the checkpoint, discard the Agent, build a fresh one
    with the same ``session_id`` (so SessionManager rehydrates messages), and
    pass the checkpoint back as a ``checkpointResume`` block. Returns the final
    Agent and the ordered list of checkpoints observed along the way.
    """
    agent = _build_agent(tools, session_id=session_id, storage_dir=storage_dir)
    result = await agent.invoke_async(first_prompt)

    checkpoints: list[Checkpoint] = []
    resumes = 0
    while result.stop_reason == "checkpoint":
        assert result.checkpoint is not None, "checkpoint field must be populated on pause"
        checkpoints.append(result.checkpoint)

        # Round-trip through JSON to prove the checkpoint survives serialization.
        persisted = json.loads(json.dumps(result.checkpoint.to_dict()))

        # Discard the Agent. A fresh Agent with the same session_id will
        # rehydrate messages from the session store, then resume at the
        # captured checkpoint position.
        del agent
        agent = _build_agent(tools, session_id=session_id, storage_dir=storage_dir)

        result = await agent.invoke_async({"checkpointResume": {"checkpoint": persisted}})

        resumes += 1
        if resumes > max_resumes:
            raise AssertionError(f"exceeded max_resumes={max_resumes} without reaching end_turn")

    assert result.stop_reason == "end_turn", f"unexpected terminal stop_reason: {result.stop_reason}"
    return agent, checkpoints


async def test_checkpoint_roundtrip_completes_through_fresh_agent(tmp_path):
    """Pause at a cycle boundary, resume on a fresh Agent, reach end_turn.

    Single-tool prompt forces at least one ``after_model`` + ``after_tools``
    pair before the final ``end_turn`` cycle.
    """

    @tool
    def get_color_of_sky() -> str:
        """Return the color of the sky."""
        return "blue"

    final_agent, checkpoints = await _drive_to_completion(
        tools=[get_color_of_sky],
        first_prompt="What color is the sky? Use the get_color_of_sky tool.",
        session_id="roundtrip",
        storage_dir=tmp_path,
    )

    assert len(checkpoints) >= 1
    assert all(cp.position in ("after_model", "after_tools") for cp in checkpoints)

    # Cycle indices are non-decreasing.
    cycle_indices = [cp.cycle_index for cp in checkpoints]
    assert cycle_indices == sorted(cycle_indices), f"cycle indices not monotonic: {cycle_indices}"

    # Final agent's message history (rehydrated by SessionManager) contains
    # the tool result and a final assistant message that references it.
    tool_result_texts = [
        block["toolResult"]["content"][0]["text"]
        for message in final_agent.messages
        for block in message["content"]
        if "toolResult" in block
    ]
    assert "blue" in tool_result_texts
    final_message_text = json.dumps(final_agent.messages[-1]).lower()
    assert "blue" in final_message_text


async def test_checkpoint_survives_process_boundary_no_tool_rerun(tmp_path):
    """Completed tool calls are not re-invoked across a checkpoint resume.

    Each tool increments a local counter on every call. After driving the
    agent through multiple resume cycles (with SessionManager rehydrating
    state and Checkpoint signalling pause points), each tool must have been
    called exactly once.
    """
    call_counts = {"time": 0, "day": 0, "weather": 0}

    @tool
    def get_time() -> str:
        """Return the current time."""
        call_counts["time"] += 1
        return "12:01"

    @tool
    def get_day() -> str:
        """Return the current day of the week."""
        call_counts["day"] += 1
        return "monday"

    @tool
    def get_weather() -> str:
        """Return the current weather."""
        call_counts["weather"] += 1
        return "sunny"

    final_agent, checkpoints = await _drive_to_completion(
        tools=[get_time, get_day, get_weather],
        first_prompt=("What is the time, the day, and the weather? Use the get_time, get_day, and get_weather tools."),
        session_id="no-rerun",
        storage_dir=tmp_path,
    )

    assert call_counts == {"time": 1, "day": 1, "weather": 1}, (
        f"tools were re-executed on resume — counts: {call_counts}"
    )

    assert any(cp.position == "after_tools" for cp in checkpoints), (
        f"no after_tools checkpoint observed: {[cp.position for cp in checkpoints]}"
    )

    final_message_text = json.dumps(final_agent.messages[-1]).lower()
    assert all(s in final_message_text for s in ["12:01", "monday", "sunny"])


async def test_checkpoint_resume_preserves_conversation_history(tmp_path):
    """The user's original prompt survives the full checkpoint/resume cycle.

    Combining SessionManager (for state) with Checkpoint (for pause signalling)
    gives the resumed agent both the original prompt and the tool results
    needed to produce a coherent final response.
    """

    @tool
    def get_favorite_number() -> int:
        """Return the user's favorite number."""
        return 42

    final_agent, _ = await _drive_to_completion(
        tools=[get_favorite_number],
        first_prompt="What is my favorite number? Use the get_favorite_number tool.",
        session_id="history",
        storage_dir=tmp_path,
    )

    user_messages = [m for m in final_agent.messages if m["role"] == "user"]
    first_user_message_text = json.dumps(user_messages[0]).lower()
    assert "favorite number" in first_user_message_text

    assert final_agent.messages[-1]["role"] == "assistant"
    assert "42" in json.dumps(final_agent.messages[-1])
