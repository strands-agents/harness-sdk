"""Shared setup for end-to-end integration tests.

These build a real agent via ``create_harness`` and run turns against a live model (Bedrock by default), so they
need AWS credentials and cost money/latency. They live outside ``testpaths`` (``tests/``), so the
default unit run (``pytest``) never collects them; run them explicitly with ``pytest tests_integ``.

Assertions check observable side effects (a file created, a tool blocked), never the model's exact
prose — the model is non-deterministic, the effect is not.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from strands import Agent

from strands_harness import create_harness

# A small, fast model keeps these cheap; override with STRANDS_INTEG_MODEL. Thinking is off because the
# Haiku default rejects the reasoning-effort field and it isn't needed for these checks.
INTEG_MODEL = os.environ.get("STRANDS_INTEG_MODEL", "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0")


@pytest.fixture
def work_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A clean temp directory that is also the process cwd, so the agent's sandbox file/shell ops
    (which resolve against cwd) stay isolated to the test."""
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def build_agent() -> Callable[..., Agent]:
    """Factory for a real, integ-configured agent: the small model, effort off, the built-in
    plugins disabled, and sessions off by default (built-in tools include ``subagent``; drop it via
    ``builtin_tools`` if a test needs it off) so a test exercises exactly what it sets up. Background
    Tasks retain the harness's default policy. Any keyword overrides the defaults."""

    def _build(**overrides: Any) -> Agent:
        options: dict[str, Any] = {
            "model": INTEG_MODEL,
            "effort": "off",
            "builtin_plugins": [],
            "session": False,
        }
        options.update(overrides)
        return create_harness(**options)

    return _build


@pytest.fixture
def tool_succeeded() -> Callable[[Agent, str], bool]:
    """Predicate: did the agent call the named tool and get a successful result? Inspects the
    conversation (`toolUse` name matched to a `toolResult` with ``status == "success"``), so a test
    can assert a tool was actually exercised end to end rather than guessing from the model's prose."""

    def _check(agent: Agent, name: str) -> bool:
        used: set[str] = set()
        succeeded: set[str] = set()
        for message in agent.messages:
            for block in message.get("content", []):
                if not isinstance(block, dict):
                    continue
                use = block.get("toolUse")
                result = block.get("toolResult")
                if use and use.get("name") == name:
                    used.add(use.get("toolUseId"))
                if result and result.get("status") == "success":
                    succeeded.add(result.get("toolUseId"))
        return bool(used & succeeded)

    return _check


@pytest.fixture
def tool_attempted() -> Callable[[Agent, str], bool]:
    """Predicate: did the agent emit a `toolUse` for the named tool at all, regardless of outcome?
    Lets a test prove a blocked call was actually attempted (then denied) rather than silently
    skipped — so a passing "was not used successfully" assertion can't be a false pass."""

    def _check(agent: Agent, name: str) -> bool:
        for message in agent.messages:
            for block in message.get("content", []):
                if isinstance(block, dict):
                    use = block.get("toolUse")
                    if use and use.get("name") == name:
                        return True
        return False

    return _check


@pytest.fixture
def tool_result_contains() -> Callable[[Agent, str, str], bool]:
    """Predicate: did the named tool return a result whose content contains `needle`? Checks the
    tool's own output (matched via toolUseId), not the model's closing prose — so a test can assert a
    tool produced the right value (e.g. `read` returned the file's contents) robustly."""

    def _check(agent: Agent, name: str, needle: str) -> bool:
        ids: set[str] = set()
        for message in agent.messages:
            for block in message.get("content", []):
                if isinstance(block, dict) and (use := block.get("toolUse")) and use.get("name") == name:
                    ids.add(use.get("toolUseId"))
        for message in agent.messages:
            for block in message.get("content", []):
                if isinstance(block, dict) and (result := block.get("toolResult")) and result.get("toolUseId") in ids:
                    if needle in str(result.get("content")):
                        return True
        return False

    return _check
