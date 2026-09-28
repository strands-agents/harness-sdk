"""Tests for the ``interventions`` sugar resolver."""

import pytest
from strands.vended_interventions.hitl import HumanInTheLoop
from strands.vended_interventions.hitl.classifier import LLMClassifierConfig

from strands_harness.interventions import resolve_interventions

# Cedar is an optional dependency (``strands-agents[cedar]``), not part of ``[dev]``. Tests that need
# a real ``CedarAuthorization`` instance skip when it isn't installed; importing it at module level
# would fail collection of the whole file on a lean install.


def test_none_and_off_register_nothing():
    assert resolve_interventions(None) == []
    assert resolve_interventions("off") == []
    assert resolve_interventions(["off"]) == []


def test_ask_gates_every_tool():
    (handler,) = resolve_interventions("ask")
    assert isinstance(handler, HumanInTheLoop)
    # No allow-list: every tool call requires approval.
    assert handler._allowed_tools == set()
    assert handler._classifier is None


def test_smart_uses_the_llm_classifier():
    (handler,) = resolve_interventions("smart")
    # No allow-list: the classifier judges every call (the harness makes no read/write assumptions).
    assert handler._allowed_tools == set()
    assert handler._classifier is not None


def test_natural_language_becomes_the_classifier_prompt():
    prompt = "Read-only overall, but writes under ./out are fine"
    (handler,) = resolve_interventions(prompt)
    assert isinstance(handler, HumanInTheLoop)
    assert handler._allowed_tools == set()
    # The NL policy is threaded through as the LLM risk classifier's system prompt.
    assert handler._classifier is not None


def test_cedar_file_path_loads_a_cedar_handler(tmp_path):
    cedar = pytest.importorskip("strands.vended_interventions.cedar", exc_type=ImportError)
    policy = tmp_path / "agent.cedar"
    policy.write_text('permit(principal, action == Action::"read", resource);')
    (handler,) = resolve_interventions(str(policy))
    assert isinstance(handler, cedar.CedarAuthorization)


def test_dot_cedar_suffix_is_treated_as_cedar(tmp_path, monkeypatch):
    # A ``.cedar`` name routes to Cedar even before the file exists on disk; the SDK loader raises
    # on a missing file, which is the right failure (a policy path that isn't there).
    with pytest.raises((FileNotFoundError, ValueError, OSError)):
        resolve_interventions("does-not-exist.cedar")


def test_a_non_cedar_string_matching_a_file_is_still_natural_language(tmp_path, monkeypatch):
    # Cedar detection is by ``.cedar`` suffix only, not file existence: a natural-language policy
    # that happens to match a filename in the working directory must not be misrouted to Cedar.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "notes").write_text("some text")
    (handler,) = resolve_interventions("notes")
    assert isinstance(handler, HumanInTheLoop)
    assert handler._classifier is not None


def test_handler_instance_passes_through():
    handler = HumanInTheLoop(ask="stdio", enable_trust=True)
    assert resolve_interventions(handler) == [handler]


def test_list_layers_cedar_and_a_preset(tmp_path):
    cedar = pytest.importorskip("strands.vended_interventions.cedar", exc_type=ImportError)
    policy = tmp_path / "p.cedar"
    policy.write_text('permit(principal, action == Action::"read", resource);')
    handlers = resolve_interventions([str(policy), "ask"])
    assert len(handlers) == 2
    assert {type(h) for h in handlers} == {cedar.CedarAuthorization, HumanInTheLoop}


def test_two_human_approval_handlers_collide():
    with pytest.raises(ValueError, match="at most one"):
        resolve_interventions(["ask", "smart"])


def test_ask_mode_threads_into_the_handler():
    (interrupt_handler,) = resolve_interventions("ask")
    assert interrupt_handler._ask is None
    (stdio_handler,) = resolve_interventions("ask", ask="stdio")
    assert stdio_handler._ask is not None


def test_invalid_value_raises():
    with pytest.raises(ValueError, match="Invalid interventions value"):
        resolve_interventions(123)  # type: ignore[arg-type]


def test_explicit_classifier_config_prompt_is_preserved():
    cfg = LLMClassifierConfig(system_prompt="only approve deletes")
    handler = HumanInTheLoop(classifier=cfg)
    assert resolve_interventions(handler) == [handler]
