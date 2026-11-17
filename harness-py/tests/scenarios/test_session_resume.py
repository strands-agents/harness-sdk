from __future__ import annotations

from unittest.mock import ANY

from recording import check_invariants, record
from scripted_model import Reply, ScriptedModel

from strands_harness import create_harness


def test_sends_the_first_agents_conversation_unchanged_then_the_new_message_from_an_agent_rebuilt_on_the_session(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    notes = str(tmp_path / "notes.txt")
    session = {"id": "resume"}
    todos = [{"content": "Take notes", "activeForm": "Taking notes", "status": "in_progress"}]
    first_model = ScriptedModel(
        [
            [("write", {"path": notes, "content": "alpha\n"})],
            "Wrote the notes.",
            Reply(reasoning="The file holds alpha.", text="They say alpha."),
        ]
    )
    first = create_harness(model=first_model, session=session, memory=False, callback_handler=None)
    first.state.set("todos", todos)
    first_recording = record(first)
    first("Write the notes.")
    first("What do the notes say?")

    second_model = ScriptedModel(["Nothing else."])
    second = create_harness(model=second_model, session=session, memory=False, callback_handler=None)
    recording = record(second)
    second("Anything else?")

    third_model = ScriptedModel(["Goodbye."])
    third = create_harness(model=third_model, session=session, memory=False, callback_handler=None)
    third_recording = record(third)
    third("Goodbye.")

    for model in (first_model, second_model, third_model):
        model.assert_exhausted()
    check_invariants(first_recording, first)
    check_invariants(recording, second)
    check_invariants(third_recording, third)
    assert second.state.get("todos") == todos
    assert recording.calls[0].system_prompt == first_recording.calls[0].system_prompt
    assert recording.calls[0].system_prompt_content == first_recording.calls[0].system_prompt_content
    tru_messages = recording.calls[0].messages
    exp_messages = [
        {"role": "user", "content": [{"text": "Write the notes."}]},
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "scripted-1",
                        "name": "write",
                        "input": {"path": notes, "content": "alpha\n"},
                    }
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "scripted-1",
                        "status": "success",
                        "content": [{"text": f"Wrote 2 lines to {notes}."}],
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "Wrote the notes."}]},
        {"role": "user", "content": [{"text": "What do the notes say?"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "reasoningContent": {
                        "reasoningText": {"text": "The file holds alpha.", "signature": "scripted-signature"}
                    }
                },
                {"text": "They say alpha."},
            ],
        },
        {"role": "user", "content": [{"text": "Anything else?"}, {"text": ANY}]},
    ]
    assert tru_messages == exp_messages

    tru_third_messages = third_recording.calls[0].messages
    exp_third_messages = [
        *exp_messages[:-1],
        {"role": "user", "content": [{"text": "Anything else?"}]},
        {"role": "assistant", "content": [{"text": "Nothing else."}]},
        {"role": "user", "content": [{"text": "Goodbye."}, {"text": ANY}]},
    ]
    assert tru_third_messages == exp_third_messages
