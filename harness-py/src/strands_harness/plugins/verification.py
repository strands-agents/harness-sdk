"""Verification: run the project's own checks before the agent may report a change as done.

When an invocation ends normally and the agent called a tool that can change the workspace, the
plugin runs each check command through the agent's ``sandbox`` (the seam the ``shell`` tool uses, so
a Docker or SSH sandbox runs the checks where the files live). If every check exits ``0`` the answer
stands. If one fails, its exit code and the tail of its output are fed back as a user message through
``AfterInvocationEvent.resume`` and the agent keeps working. When the attempt budget is spent the agent
gets one last turn to tell the user what still fails, so a run never ends on an unverified "done".

The outcome of the latest verification is written to ``agent.state`` under ``verification``.

Checks are plain commands, never model calls. An invocation that only read, searched or planned (see
``_READ_ONLY_TOOLS``) runs no checks. One that ends any other way than a normal end of turn (an
interrupt for approval, a cancellation, a limit) runs none either, but keeps its run open, so the
changes it made are verified when a later invocation on the agent finishes normally.
"""

from __future__ import annotations

import logging
import weakref
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from strands import SandboxTimeoutError
from strands.hooks import AfterInvocationEvent, AfterToolCallEvent, BeforeInvocationEvent
from strands.plugins import Plugin

if TYPE_CHECKING:
    from strands import Agent

logger = logging.getLogger(__name__)

_DEFAULT_NAME = "strands:verification"
STATE_KEY = "verification"
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_TIMEOUT = 600.0

# Output kept per failed check: the tail, where test runners and compilers print their summary.
_OUTPUT_TAIL_CHARS = 4_000

# Tools that cannot change the workspace. Every other tool (consumer and MCP tools included) counts as
# a possible change, so an unknown tool errs toward running the checks.
_READ_ONLY_TOOLS = frozenset({"read", "web_fetch", "web_search", "todo_write", "search_memory", "skills"})

# ``"auto"`` detection, first match wins: (file, text the file must contain, command).
_AUTO_CHECKS: tuple[tuple[str, str, str], ...] = (
    ("package.json", '"test"', "npm test"),
    ("pyproject.toml", "", "python -m pytest -q"),
    ("Cargo.toml", "", "cargo test"),
    ("go.mod", "", "go test ./..."),
    ("Makefile", "test:", "make test"),
)

VerificationStatus = Literal["passed", "failed", "no_checks"]


@dataclass
class _CheckResult:
    command: str
    exit_code: int | None
    output: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


@dataclass
class _Run:
    changed: bool = False
    attempts: int = 0
    reporting: bool = False
    carry_over: bool = False
    last: list[_CheckResult] = field(default_factory=list)


def _tail(text: str) -> str:
    if len(text) <= _OUTPUT_TAIL_CHARS:
        return text
    return f"[... {len(text) - _OUTPUT_TAIL_CHARS} earlier characters omitted ...]\n{text[-_OUTPUT_TAIL_CHARS:]}"


def _failure_block(check: _CheckResult) -> str:
    status = "timed out" if check.exit_code is None else f"exit code {check.exit_code}"
    return f"$ {check.command}\n{status}\n{_tail(check.output)}"


def _failure_prompt(failed: list[_CheckResult], attempt: int, max_attempts: int) -> str:
    body = "\n\n".join(_failure_block(check) for check in failed)
    return (
        f"<verification>\nThe project's checks failed after your changes (attempt {attempt} of {max_attempts}).\n\n"
        f"{body}\n\nFix the cause and make these checks pass. Do not skip, weaken or delete the checks.\n"
        "</verification>"
    )


def _report_prompt(failed: list[_CheckResult], max_attempts: int) -> str:
    commands = "\n".join(f"- {check.command}" for check in failed)
    return (
        f"<verification>\nThe project's checks still fail after {max_attempts} attempts:\n{commands}\n\n"
        "Stop changing files. Tell the user plainly that the task is not verified, which checks still fail, "
        "and what you believe is wrong.\n</verification>"
    )


async def _read_text(agent: Agent, path: str) -> str | None:
    try:
        return await agent.sandbox.read_text(path)
    except Exception:
        return None


async def detect_checks(agent: Agent) -> list[str]:
    """The check ``"auto"`` resolves to in the agent's working directory, or ``[]`` when nothing matches."""
    for path, marker, command in _AUTO_CHECKS:
        text = await _read_text(agent, path)
        if text is not None and marker in text:
            return [command]
    return []


class Verification(Plugin):
    """Runs the project's checks when the agent finishes an invocation that changed the workspace.

    Only one plugin may drive ``AfterInvocationEvent.resume`` on an agent, so this plugin cannot be
    combined with a ``GoalLoop``. Sharing one instance across agents is safe: run state is per agent.

    Args:
        commands: Shell commands to run in order, or ``"auto"`` to detect one from the project files.
        max_attempts: How many failed verifications the agent may try to fix before it must report.
        timeout: Seconds each command may run; a command that runs longer counts as failed.
        name: Plugin name, for logging and duplicate detection. Defaults to ``"strands:verification"``.
    """

    def __init__(
        self,
        commands: Sequence[str] | Literal["auto"],
        *,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        timeout: float = DEFAULT_TIMEOUT,
        name: str = _DEFAULT_NAME,
    ) -> None:
        if commands != "auto" and not _is_command_list(commands):
            raise ValueError(f"commands=<{commands!r}> | must be 'auto' or a non-empty list of non-empty strings")
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or max_attempts < 1:
            raise ValueError(f"max_attempts=<{max_attempts!r}> | must be an int of at least 1")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout < float("inf"):
            raise ValueError(f"timeout=<{timeout!r}> | must be a positive number of seconds")
        self._commands: list[str] | Literal["auto"] = "auto" if commands == "auto" else list(commands)
        self._max_attempts = max_attempts
        self._timeout = float(timeout)
        self._name = name
        self._runs: weakref.WeakKeyDictionary[Agent, _Run] = weakref.WeakKeyDictionary()
        self._detected: weakref.WeakKeyDictionary[Agent, list[str]] = weakref.WeakKeyDictionary()
        super().__init__()

    @property
    def name(self) -> str:
        return self._name

    @property
    def commands(self) -> list[str] | Literal["auto"]:
        """The configured commands, or ``"auto"``."""
        return self._commands

    def init_agent(self, agent: Agent) -> None:
        """Register the hooks that track changes and run the checks."""
        agent.add_hook(self._before_invocation, BeforeInvocationEvent)
        agent.add_hook(self._after_tool_call, AfterToolCallEvent)
        agent.add_hook(self._after_invocation, AfterInvocationEvent)

    def _before_invocation(self, event: BeforeInvocationEvent) -> None:
        run = self._runs.get(event.agent)
        if run is not None and run.carry_over:
            run.carry_over = False
            return
        self._runs[event.agent] = _Run()

    def _after_tool_call(self, event: AfterToolCallEvent) -> None:
        run = self._runs.get(event.agent)
        if run is not None and event.tool_use["name"] not in _READ_ONLY_TOOLS:
            run.changed = True

    async def _after_invocation(self, event: AfterInvocationEvent) -> None:
        run = self._runs.get(event.agent)
        if run is None:
            return
        if event.result is None or event.result.stop_reason != "end_turn":
            run.carry_over = True
            return
        if run.reporting:
            self._record(event.agent, "failed", run)
            return
        if not run.changed:
            return

        commands = await self._resolve_commands(event.agent)
        if not commands:
            self._record(event.agent, "no_checks", run)
            return

        run.attempts += 1
        run.last = [await self._run_check(event.agent, command) for command in commands]
        failed = [check for check in run.last if not check.passed]
        if not failed:
            self._record(event.agent, "passed", run)
            return

        logger.debug("plugin=<%s>, attempt=<%d>, failed=<%d> | checks failed", self._name, run.attempts, len(failed))
        if run.attempts < self._max_attempts:
            event.resume = _failure_prompt(failed, run.attempts, self._max_attempts)
        else:
            run.reporting = True
            event.resume = _report_prompt(failed, self._max_attempts)
        run.carry_over = True

    async def _resolve_commands(self, agent: Agent) -> list[str]:
        if self._commands != "auto":
            return self._commands
        if agent not in self._detected:
            detected = await detect_checks(agent)
            if not detected:
                logger.warning("plugin=<%s> | verify='auto' found no test command, no checks will run", self._name)
            self._detected[agent] = detected
        return self._detected[agent]

    async def _run_check(self, agent: Agent, command: str) -> _CheckResult:
        try:
            result = await agent.sandbox.execute(command, timeout=self._timeout)
        except SandboxTimeoutError:
            return _CheckResult(command, None, f"timed out after {self._timeout:g}s")
        except Exception as e:
            return _CheckResult(command, -1, f"could not run the check: {e}")
        output = "\n".join(part for part in (result.stdout, result.stderr) if part)
        return _CheckResult(command, result.exit_code, output)

    def _record(self, agent: Agent, status: VerificationStatus, run: _Run) -> None:
        checks: list[dict[str, Any]] = [{"command": c.command, "exit_code": c.exit_code} for c in run.last]
        agent.state.set(STATE_KEY, {"status": status, "attempts": run.attempts, "checks": checks})


def _is_command_list(commands: object) -> bool:
    if isinstance(commands, str) or not isinstance(commands, Sequence) or not commands:
        return False
    return all(isinstance(command, str) and command.strip() for command in commands)
