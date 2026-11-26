"""Model switch: the conversation moves to another model family and back, with and without thinking."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import pytest
from recording import Recording, check_invariants
from strands import Agent

from strands_harness.models import supports_thinking

Build = Callable[..., Agent]
Check = Callable[[Agent, str], bool]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."

_MODEL = os.environ.get("STRANDS_INTEG_MODEL", "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0")

# A different model family, so the conversation crosses a provider-format boundary.
_SWITCH_MODEL = os.environ.get("STRANDS_INTEG_SWITCH_MODEL", "bedrock/us.openai.gpt-6-luna")

# Reasoning blocks crossing the boundary are the risk, so the first model also runs with thinking on.
_EFFORTS = ["off", "low"] if supports_thinking(_MODEL) else ["off"]

# A model built from a "provider/name" string reports the name as its id.
_MODEL_ID = _MODEL.split("/", 1)[-1]
_SWITCH_MODEL_ID = _SWITCH_MODEL.split("/", 1)[-1]


async def _read_codeword(agent: Agent, work_dir: Path) -> None:
    # The codeword enters the conversation only inside a tool result, and its file is gone before the switch.
    source = work_dir / "codeword.txt"
    source.write_text("AXOLOTL-64\n")
    await agent.invoke_async(f"{_TESTING} Use the read tool to read {source}, then reply with exactly: ok.")
    source.unlink()
    spoken = [block["text"] for message in agent.messages for block in message["content"] if "text" in block]
    assert not any("AXOLOTL-64" in text for text in spoken)


def _skip_unless_reasoning_crosses(agent: Agent, effort: str) -> None:
    reasoned = any("reasoningContent" in block for message in agent.messages for block in message["content"])
    if effort != "off" and not reasoned:
        pytest.skip("the model answered without reasoning, so no reasoning block would cross the switch")


async def _save_codeword(agent: Agent, path: Path) -> None:
    await agent.invoke_async(
        f"{_TESTING} The file you read earlier is deleted. "
        f"Use the write tool to save the codeword it held, and nothing else, to {path}."
    )


@pytest.mark.parametrize("effort", _EFFORTS)
async def test_recalls_the_codeword_and_calls_tools_on_both_models_when_agent_model_is_reassigned(
    effort: str, work_dir: Path, build_agent: Build, record_agent: Record, tool_succeeded: Check
) -> None:
    agent = build_agent(model=_MODEL, effort=effort)
    original, other = agent.model, build_agent(model=_SWITCH_MODEL).model
    recording = record_agent(agent)
    recording.attach(other)

    await _read_codeword(agent, work_dir)
    _skip_unless_reasoning_crosses(agent, effort)
    agent.model = other
    await _save_codeword(agent, work_dir / "switched.txt")
    agent.model = original
    await _save_codeword(agent, work_dir / "back.txt")

    check_invariants(recording, agent)
    assert len({id(call.model) for call in recording.calls}) == 2
    turns = zip([0, *recording.turn_ends], recording.turn_ends, strict=False)
    tru_models = [{call.model_id for call in recording.calls[start:end]} for start, end in turns]
    exp_models = [{_MODEL_ID}, {_SWITCH_MODEL_ID}, {_MODEL_ID}]
    assert tru_models == exp_models
    assert tool_succeeded(agent, "read")
    assert (work_dir / "switched.txt").read_text().strip() == "AXOLOTL-64"
    assert (work_dir / "back.txt").read_text().strip() == "AXOLOTL-64"


@pytest.mark.parametrize("effort", _EFFORTS)
async def test_recalls_the_codeword_and_calls_tools_on_both_models_when_the_agent_is_rebuilt_on_the_session(
    effort: str, work_dir: Path, build_agent: Build, record_agent: Record, tool_succeeded: Check
) -> None:
    session = {"id": "switch"}
    first = build_agent(model=_MODEL, effort=effort, session=session)
    first_recording = record_agent(first)
    await _read_codeword(first, work_dir)
    _skip_unless_reasoning_crosses(first, effort)

    second = build_agent(model=_SWITCH_MODEL, session=session)
    second_recording = record_agent(second)
    await _save_codeword(second, work_dir / "switched.txt")

    third = build_agent(model=_MODEL, effort=effort, session=session)
    third_recording = record_agent(third)
    await _save_codeword(third, work_dir / "back.txt")

    check_invariants(first_recording, first)
    check_invariants(second_recording, second)
    check_invariants(third_recording, third)
    recordings = (first_recording, second_recording, third_recording)
    tru_models = [{call.model_id for call in recording.calls} for recording in recordings]
    exp_models = [{_MODEL_ID}, {_SWITCH_MODEL_ID}, {_MODEL_ID}]
    assert tru_models == exp_models
    assert tool_succeeded(first, "read")
    assert (work_dir / "switched.txt").read_text().strip() == "AXOLOTL-64"
    assert (work_dir / "back.txt").read_text().strip() == "AXOLOTL-64"
