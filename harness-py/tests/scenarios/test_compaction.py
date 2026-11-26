from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import ANY

import pytest
from recording import check_invariants, record
from scripted_model import Reply, ScriptedModel

from strands_harness import create_harness

_SUMMARY = "The user asked to read report-0.txt and report-1.txt; both were read."


def _large_report(codeword: str) -> str:
    """Far over the size at which a tool result is offloaded, with the codeword in the part the preview leaves out."""
    lines = [f"line {line}: quarterly budget notes." for line in range(300)]
    lines[150] = codeword
    return "\n".join(lines)


@pytest.fixture
def compacted(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    paths = [str(tmp_path / f"report-{index}.txt") for index in range(3)]
    for path, codeword in zip(paths, ("ALBATROSS", "BERGAMOT", "CORMORANT"), strict=True):
        Path(path).write_text(_large_report(codeword))
    references = []

    def note_reference(messages):
        references.append(re.search(r"\[ref: ([^\]\s]+)\]", str(messages[-1])).group(1))
        return "read 0"

    model = ScriptedModel(
        [
            [("read", {"path": paths[0]})],
            note_reference,
            [("read", {"path": paths[1]})],
            "read 1",
            [("read", {"path": paths[2]})],
            Reply(text=_SUMMARY, summary=True),
            "read 2",
            lambda _messages: [("retrieve_context", {"reference": references[0], "pattern": "ALBATROSS"})],
            "retrieved",
        ]
    )
    agent = create_harness(model=model, memory=False, callback_handler=None)
    recording = record(agent)

    agent("Read report 0.")
    # Each offloaded read adds the same number of tokens, so this window puts the summarization threshold (85%)
    # half a read past the second one, whatever the fixed overhead of system prompt and tool specs is.
    overhead, after_one_read = (call.usage["inputTokens"] for call in recording.calls)
    model.update_config(context_window_limit=int((overhead + 2.5 * (after_one_read - overhead)) / 0.85))
    for prompt in ("Read report 1.", "Read report 2.", "What was hidden in report 0?"):
        agent(prompt)
    model.assert_exhausted()
    return agent, recording, paths, references[0]


def test_summarizes_older_turns_once_keeps_the_recent_exchange_verbatim_and_the_removed_content_retrievable(
    compacted,
):
    agent, recording, paths, reference = compacted

    check_invariants(recording, agent, prefix_breaks=1, auxiliary_calls=1)
    before, _summary, after = recording.calls[4:7]
    assert after.usage["inputTokens"] < before.usage["inputTokens"]
    assert reference not in str(after.messages)

    tru_reduced = after.messages
    exp_reduced = [
        {"role": "user", "content": [{"text": "Read report 0."}]},
        {"role": "assistant", "content": [{"text": "read 1"}, {"text": ANY}]},
        {"role": "user", "content": [{"text": "Read report 2."}]},
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "scripted-3",
                        "name": "read",
                        "input": {"path": paths[2]},
                    }
                }
            ],
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "scripted-3", "status": "success", "content": [{"text": ANY}]}}],
        },
    ]
    assert tru_reduced == exp_reduced
    summary_marker = tru_reduced[1]["content"][1]["text"]
    assert re.fullmatch(
        r"\[Summarized: earlier messages, ~[\d,]+ tokens\]\n\n" + re.escape(_SUMMARY) + r" \[ref: removed-[\w-]+\]",
        summary_marker,
    )
    recent_result = tru_reduced[4]["content"][0]["toolResult"]["content"][0]["text"]
    assert re.fullmatch(r"\[Truncated: .+line 299: quarterly budget notes\. \[ref: scripted-3\]", recent_result, re.S)

    assert not any("ALBATROSS" in str(call.messages) for call in recording.calls[:-1])
    assert "ALBATROSS" in str(recording.calls[-1].messages[-1])


# Not strict, and not mirrored in TypeScript (vitest has no such mark): the SDK fix is merged but not yet released.
@pytest.mark.xfail(
    strict=False,
    raises=AssertionError,
    reason="SDK bug: the summary request omits the _background_execution tool property, so it misses the prompt cache",
)
def test_summary_request_sends_the_tool_specs_the_agent_sends(compacted):
    _agent, recording, _paths, _reference = compacted
    before, summary = recording.calls[4:6]

    assert summary.tool_specs == before.tool_specs
