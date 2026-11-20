from __future__ import annotations

from recording import check_invariants, record
from scripted_model import ScriptedModel
from strands import tool

from strands_harness import create_harness


@tool
def explode(reason: str) -> str:
    """Always fails."""
    raise RuntimeError(f"explode failed: {reason}")


def test_reports_a_failed_built_in_tool_and_a_throwing_custom_tool_to_the_model_and_finishes_the_turn(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    model = ScriptedModel(
        [
            [("read", {"path": str(tmp_path / "missing.txt")}), ("explode", {"reason": "disk full"})],
            "Both tools failed.",
        ]
    )
    agent = create_harness(model=model, tools=[explode], memory=False, callback_handler=None)
    recording = record(agent)

    result = agent("Read missing.txt, then explode.")

    model.assert_exhausted()
    check_invariants(recording, agent, allowed_tool_errors=("read", "explode"))
    assert result.stop_reason == "end_turn"
    read_result, explode_result = (block["toolResult"] for block in recording.calls[1].messages[-1]["content"])
    assert read_result["status"] == "error"
    assert "FileNotFoundError" in read_result["content"][0]["text"]
    assert "missing.txt" in read_result["content"][0]["text"]
    tru_explode_result = explode_result
    exp_explode_result = {
        "toolUseId": "scripted-2",
        "status": "error",
        "content": [{"text": "Error: RuntimeError - explode failed: disk full"}],
    }
    assert tru_explode_result == exp_explode_result
