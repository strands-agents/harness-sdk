from __future__ import annotations

from unittest.mock import ANY

from recording import check_invariants, record
from scripted_model import Reply, ScriptedModel

from strands_harness import create_harness


def test_hands_each_model_the_whole_prior_conversation_when_agent_model_is_reassigned(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    notes = str(tmp_path / "notes.txt")
    model_a = ScriptedModel(
        [
            Reply(reasoning="Write the file first.", tool_uses=[("write", {"path": notes, "content": "alpha\n"})]),
            "Wrote the notes.",
            "Back on the first model.",
        ],
        model_id="model-a",
    )
    model_b = ScriptedModel([[("read", {"path": notes})], "They say alpha."], model_id="model-b")
    agent = create_harness(model=model_a, memory=False, callback_handler=None)
    recording = record(agent)

    agent("Write the notes.")
    agent.model = model_b
    recording.attach(model_b)
    agent("Read them back.")
    agent.model = model_a
    agent("Anything else?")

    model_a.assert_exhausted()
    model_b.assert_exhausted()
    check_invariants(recording, agent, prefix_breaks=0)
    turn_on_a = [
        {"role": "user", "content": [{"text": "Write the notes."}]},
        {
            "role": "assistant",
            "content": [
                {
                    "reasoningContent": {
                        "reasoningText": {"text": "Write the file first.", "signature": "scripted-signature"}
                    }
                },
                {
                    "toolUse": {
                        "toolUseId": "model-a-1",
                        "name": "write",
                        "input": {"path": notes, "content": "alpha\n"},
                    }
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "model-a-1",
                        "status": "success",
                        "content": [{"text": f"Wrote 2 lines to {notes}."}],
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "Wrote the notes."}]},
    ]
    turn_on_b = [
        {"role": "user", "content": [{"text": "Read them back."}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "model-b-1", "name": "read", "input": {"path": notes}}}],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "model-b-1",
                        "status": "success",
                        "content": [{"text": "     1\talpha\n     2\t"}],
                    }
                }
            ],
        },
        {"role": "assistant", "content": [{"text": "They say alpha."}]},
    ]
    tru_models = [call.model_id for call in recording.calls]
    exp_models = ["model-a", "model-a", "model-b", "model-b", "model-a"]
    assert tru_models == exp_models

    tru_first_on_b = recording.calls[2].messages
    exp_first_on_b = [*turn_on_a, {"role": "user", "content": [{"text": "Read them back."}, {"text": ANY}]}]
    assert tru_first_on_b == exp_first_on_b

    tru_back_on_a = recording.calls[4].messages
    exp_back_on_a = [*turn_on_a, *turn_on_b, {"role": "user", "content": [{"text": "Anything else?"}, {"text": ANY}]}]
    assert tru_back_on_a == exp_back_on_a
