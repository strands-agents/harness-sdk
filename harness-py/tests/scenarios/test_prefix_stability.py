from __future__ import annotations

import os
from pathlib import Path

import pytest
from recording import check_invariants, record
from scripted_model import ScriptedModel

from strands_harness import HARNESS_CONTRACT, create_harness

# A few hundred characters: too small to be offloaded, large enough that a truncated result loses its last line.
_NOTES = (
    "".join(f"note {line}: keep the scenario notes long enough to matter.\n" for line in range(12)) + "end-of-notes\n"
)


@pytest.mark.filterwarnings("ignore:The todos built-in plugin is deprecated")
def test_sends_a_byte_identical_system_prompt_tool_specs_and_earlier_messages_on_every_request(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "AGENTS.md").write_text("Keep answers short.\n")
    notes = str(tmp_path / "notes.txt")
    model = ScriptedModel(
        [
            [("write", {"path": notes, "content": _NOTES})],
            "Wrote the notes.",
            [("read", {"path": notes})],
            [("shell", {"command": "echo scenario-marker"})],
            "Read them back.",
            [
                (
                    "todo_write",
                    {"todos": [{"content": "Take notes", "activeForm": "Taking notes", "status": "completed"}]},
                )
            ],
            "All done.",
        ]
    )
    # Memory is off in the offline scenarios: with it on, a fact-extraction request follows every turn.
    agent = create_harness(model=model, builtin_plugins=["todos", "environment"], memory=False, callback_handler=None)
    agent.state.set("todos", [{"content": "Take notes", "activeForm": "Taking notes", "status": "in_progress"}])
    recording = record(agent)

    for prompt in ("Write the notes.", "Read them back and echo a marker.", "Mark the todo done."):
        agent(prompt)

    model.assert_exhausted()
    check_invariants(recording, agent, prefix_breaks=0)
    assert len(recording.calls) == 7
    first = recording.calls[0]
    assert HARNESS_CONTRACT in (first.system_prompt or "")
    tru_tools = sorted(spec["name"] for spec in first.tool_specs)
    exp_tools = [
        "edit",
        "programmatic_tool_caller",
        "read",
        "retrieve_context",
        "shell",
        "strands_manage_background_task",
        "subagent",
        "todo_write",
        "web_fetch",
        "write",
    ]
    assert tru_tools == exp_tools
    tru_descriptions = {spec["name"]: spec["description"] for spec in first.tool_specs}
    exp_descriptions = {spec["name"]: spec["description"] for spec in agent.tool_registry.get_all_tool_specs()}
    assert tru_descriptions == exp_descriptions
    assert all(tru_descriptions.values())
    for call in recording.calls[1:]:
        assert call.system_prompt == first.system_prompt
        assert call.system_prompt_content == first.system_prompt_content
        assert call.tool_specs == first.tool_specs
    assert Path(notes).read_text() == _NOTES
    read_result, shell_result = (
        next(block["toolResult"] for block in call.messages[-1]["content"] if "toolResult" in block)
        for call in recording.calls[3:5]
    )
    assert "end-of-notes" in str(read_result["content"])
    assert "scenario-marker" in str(shell_result["content"])

    reminders = [
        "".join(
            block["text"]
            for block in call.messages[-1]["content"][
                len(call.messages[-1]["content"]) - call.dynamic_trailing_blocks :
            ]
        )
        for call in recording.calls
    ]
    # The environment reminder joins the todo reminder on the first request of each turn.
    assert [call.dynamic_trailing_blocks for call in recording.calls] == [2, 1, 2, 1, 1, 2, 1]
    assert all("Your current todo list" in reminder for reminder in reminders)
    assert "[in_progress] Taking notes" in reminders[0]
    for turn_start in (reminders[0], reminders[2], reminders[5]):
        assert "Keep answers short." in turn_start
        assert "Date: " in turn_start
        assert f"Working directory: {os.getcwd()}" in turn_start
    assert "[completed] Take notes" in reminders[-1]
    # The SDK keeps a reminder in the history as an injected block and never as text, which would be re-sent.
    persisted_text = [block["text"] for message in agent.messages for block in message["content"] if "text" in block]
    assert not any("<system-reminder>" in text for text in persisted_text)
