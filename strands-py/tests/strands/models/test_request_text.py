import pytest

from strands.experimental.decisions import project_state
from strands.models._request_text import CHARS_PER_TOKEN, NO_REQUEST_TEXT, OMISSION_MARKER


def test_project_state_takes_latest_request_and_instruction_text():
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "reply"}]},
        {"role": "user", "content": [{"text": "second"}, {"image": {}}, {"guardContent": {"text": {"text": "x"}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "t", "content": []}}]},
    ]
    system_prompt = [{"text": "be terse"}, {"cachePoint": {"type": "default"}}]

    tru_state = project_state(messages, system_prompt, max_tokens=100)

    assert tru_state == {"request": "second\n[Image]\n[Guarded content]", "agent_instructions": "be terse"}


def test_project_state_bounds_each_field_by_its_token_budget():
    long_text = "a" * 1_000

    tru_state = project_state(
        [{"role": "user", "content": [{"text": long_text}]}], long_text, max_tokens=50, max_instruction_tokens=20
    )

    assert len(tru_state["request"]) == 50 * CHARS_PER_TOKEN
    assert len(tru_state["agent_instructions"]) == 20 * CHARS_PER_TOKEN
    assert OMISSION_MARKER in tru_state["request"]


def test_project_state_without_request_or_prompt():
    assert project_state([], None, max_tokens=100) == {"request": NO_REQUEST_TEXT, "agent_instructions": ""}


@pytest.mark.parametrize("budget", [0, -1, 1.5, True])
def test_project_state_rejects_invalid_budgets(budget):
    with pytest.raises(ValueError, match="positive integer"):
        project_state([], None, max_tokens=budget)
    with pytest.raises(ValueError, match="positive integer"):
        project_state([], None, max_tokens=10, max_instruction_tokens=budget)
