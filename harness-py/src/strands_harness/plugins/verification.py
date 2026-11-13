"""Verification: run the project's own checks before the agent may report a change as done.

``Verification`` is a ``GoalLoop`` whose goal is "the project's checks pass". When an invocation that changed the
workspace ends normally (end of turn, stop sequence, ``AfterToolsEvent.end_turn``, or structured output), the
validator runs each check through ``agent.sandbox``. A failing check's exit code and output tail become the GoalLoop
feedback, so the agent keeps working. After ``max_attempts`` failed check runs the last answer is returned unverified,
with a warning. The outcome is written to ``agent.state["verification"]``.

An invocation that stops early (interrupt, cancel, ``max_tokens``, limit) runs no checks: its changes are carried to
the next invocation and recorded as ``pending``, and their attempt count carries with them.

A validator sees only the last message, so read-only hooks record what it cannot: which tools ran and how the
invocation ended. A validator cannot say "not graded" either, so it passes an invocation it does not grade, and
``last_result`` reports Verification's own outcome instead of GoalLoop's.
"""

from __future__ import annotations

import json
import logging
import weakref
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from strands import SandboxTimeoutError
from strands.hooks import AfterInvocationEvent, AfterModelCallEvent, AfterToolCallEvent, AfterToolsEvent, HookOrder
from strands.tools.structured_output.structured_output_tool import StructuredOutputTool
from strands.vended_plugins.goal import GoalAttempt, GoalLoop, GoalResult, ValidationOutcome

if TYPE_CHECKING:
    from strands import Agent
    from strands.types.content import Message

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

# Model stop reasons that end an invocation normally, so its changes are graded.
_NORMAL_STOPS = frozenset({"end_turn", "stop_sequence"})

# ``"auto"`` detection, first match wins: (file, text the file must contain, command). ``package.json`` is
# checked by parsing it instead (see ``_has_npm_test``).
_AUTO_CHECKS: tuple[tuple[str, str, str], ...] = (
    ("package.json", "", "npm test"),
    ("pyproject.toml", "", "python -m pytest -q"),
    ("Cargo.toml", "", "cargo test"),
    ("go.mod", "", "go test ./..."),
    ("Makefile", "test:", "make test"),
)

VerificationStatus = Literal["passed", "failed", "no_checks", "pending"]


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
    """One request: a set of changes from the first edit until an invocation ends normally and they are graded.

    It spans GoalLoop's retries and any invocation that stopped early (interrupt, cancel, ``max_tokens``, limit).
    """

    changed: bool = False
    # A change landed after the last check run: the record no longer describes the workspace.
    dirty: bool = False
    ended_turn: bool = False
    attempts: int = 0
    failed: bool = False
    last: list[_CheckResult] = field(default_factory=list)
    history: list[GoalAttempt] = field(default_factory=list)


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


def _retry_prompt(feedback: str | None) -> str:
    # The feedback is already the whole retry message; GoalLoop's default wording asks for a rewritten answer.
    return feedback or "<verification>\nThe project's checks failed. Fix the cause and make them pass.\n</verification>"


async def _read_text(agent: Agent, path: str) -> str | None:
    try:
        return await agent.sandbox.read_text(path)
    except Exception:
        return None


async def detect_checks(agent: Agent) -> list[str]:
    """The check ``"auto"`` resolves to in the agent's working directory, or ``[]`` when nothing matches."""
    for path, marker, command in _AUTO_CHECKS:
        text = await _read_text(agent, path)
        if text is None or marker not in text:
            continue
        if path == "package.json" and not _has_npm_test(text):
            continue
        return [command]
    return []


def _has_npm_test(text: str) -> bool:
    """Whether a ``package.json`` defines a non-empty ``scripts.test``; malformed JSON counts as no."""
    try:
        scripts = json.loads(text).get("scripts")
    except (ValueError, AttributeError):
        return False
    test = scripts.get("test") if isinstance(scripts, dict) else None
    return isinstance(test, str) and bool(test.strip())


class Verification(GoalLoop):
    """A ``GoalLoop`` whose goal is the project's checks passing after the agent changed the workspace.

    Only one GoalLoop may drive an agent, so this plugin cannot be combined with another one. Sharing one
    instance across agents is safe: run state is per agent.

    Args:
        commands: Shell commands to run in order, or ``"auto"`` to detect one from the project files.
        max_attempts: Most times the checks run in one request; every failure before the last sends the agent
            back to fix it.
        timeout: Seconds each command may run; a command that runs longer counts as failed.
        name: Plugin name, for logging. Defaults to ``"strands:verification"``.
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
        self._check_timeout = float(timeout)
        self._attempt_limit = max_attempts
        self._requests: weakref.WeakKeyDictionary[Agent, _Run] = weakref.WeakKeyDictionary()
        self._results: weakref.WeakKeyDictionary[Agent, GoalResult] = weakref.WeakKeyDictionary()
        self._warned_no_checks: weakref.WeakSet[Agent] = weakref.WeakSet()
        super().__init__(self._verify, max_attempts=max_attempts, name=name, resume_prompt_template=_retry_prompt)

    @property
    def commands(self) -> list[str] | Literal["auto"]:
        """The configured commands, or ``"auto"``."""
        return self._commands

    def last_result(self, agent: Agent) -> GoalResult | None:
        """Outcome of the latest finished request on ``agent``, from Verification's own check runs.

        ``None`` while changes are still unverified (a request in flight, or one carried over after an early
        stop). A request that ran no check falls back to GoalLoop's result.
        """
        if agent in self._requests:
            return None
        result = self._results.get(agent)
        return result if result is not None else super().last_result(agent)

    def init_agent(self, agent: Agent) -> None:
        """Register the observers, then GoalLoop's own hooks."""
        # Registered before GoalLoop's on purpose: After* callbacks run in reverse registration order, so
        # ``_after_invocation`` runs after GoalLoop's and sees whether it armed a retry.
        agent.add_hook(self._after_model_call, AfterModelCallEvent)
        agent.add_hook(self._after_tool_call, AfterToolCallEvent)
        # SDK_LAST: runs after every default-order hook, so it reads the final ``end_turn`` whoever set it.
        agent.add_hook(self._after_tools, AfterToolsEvent, order=HookOrder.SDK_LAST)
        agent.add_hook(self._after_invocation, AfterInvocationEvent)
        super().init_agent(agent)

    def _after_model_call(self, event: AfterModelCallEvent) -> None:
        run = self._requests.setdefault(event.agent, _Run())
        run.ended_turn = event.stop_response is not None and event.stop_response.stop_reason in _NORMAL_STOPS

    def _after_tool_call(self, event: AfterToolCallEvent) -> None:
        if isinstance(event.selected_tool, StructuredOutputTool):
            # The structured-output tool records the answer; it changes nothing. Its success ends the invocation.
            if event.result.get("status") == "success":
                self._requests.setdefault(event.agent, _Run()).ended_turn = True
            return
        if event.tool_use["name"] not in _READ_ONLY_TOOLS:
            run = self._requests.setdefault(event.agent, _Run())
            run.changed = run.dirty = True

    def _after_tools(self, event: AfterToolsEvent) -> None:
        if event.end_turn:
            self._requests.setdefault(event.agent, _Run()).ended_turn = True

    async def _verify(self, response: Message, agent: Agent) -> bool | ValidationOutcome:
        """The GoalLoop validator: pass unless a finished invocation changed the workspace and a check fails."""
        run = self._requests.get(agent)
        # Nothing to grade when the invocation stopped early (its changes are checked once a later one finishes)
        # or changed nothing. Passing is also what keeps GoalLoop from resuming a run paused for approval.
        if run is None or not run.ended_turn or not run.changed:
            return True

        try:
            commands = await self._resolve_commands(agent)
        except Exception as e:  # a custom sandbox's read_text may raise anything; never let it read as a pass
            commands = []
            run.last = [_CheckResult("verify", -1, f"could not resolve the checks: {e}")]
        else:
            if not commands:
                run.dirty = False
                self._record(agent, "no_checks", run)
                return True
            run.last = [await self._run_check(agent, command) for command in commands]

        run.attempts += 1
        run.dirty = False
        failed = [check for check in run.last if not check.passed]
        run.failed = bool(failed)
        feedback = _failure_prompt(failed, run.attempts, self._attempt_limit) if failed else None
        run.history.append(GoalAttempt(attempt=run.attempts, passed=not failed, feedback=feedback))
        self._record(agent, "failed" if failed else "passed", run)
        if not failed:
            return True
        logger.debug("plugin=<%s>, attempt=<%d>, failed=<%d> | checks failed", self.name, run.attempts, len(failed))
        if run.attempts >= self._attempt_limit:
            # Out of attempts. Passing is the only answer that stops GoalLoop: after an interrupt its own count
            # restarted, so a failure would arm another retry. ``last_result`` reports the failure instead.
            return True
        return ValidationOutcome(passed=False, feedback=feedback)

    def _after_invocation(self, event: AfterInvocationEvent) -> None:
        run = self._requests.get(event.agent)
        if run is None:
            return
        run_ended_turn, run.ended_turn = run.ended_turn, False
        if event.resume is not None:
            return  # GoalLoop retries after a failed check: the same request continues
        if run.dirty or (run.changed and not run_ended_turn):
            # Stopped early (or GoalLoop never graded the pass): carry the changes, attempts included, to the next
            # invocation. The request is unfinished, so the record says so: ``pending`` exactly while
            # ``last_result`` is ``None``.
            self._record(event.agent, "pending", run)
            return
        del self._requests[event.agent]
        if not run.history:
            self._results.pop(event.agent, None)
            return
        if not run.failed:
            self._results[event.agent] = GoalResult(passed=True, stop_reason="satisfied", attempts=run.history)
            return
        goal = super().last_result(event.agent)
        stop = goal.stop_reason if goal is not None and goal.stop_reason != "satisfied" else "max_attempts"
        self._results[event.agent] = GoalResult(passed=False, stop_reason=stop, attempts=run.history)
        logger.warning(
            "plugin=<%s>, attempts=<%d> | checks still fail, returning the answer unverified", self.name, run.attempts
        )

    async def _resolve_commands(self, agent: Agent) -> list[str]:
        if self._commands != "auto":
            return self._commands
        # Detected on every graded run, not cached: an agent that scaffolds a project later gets its checks.
        detected = await detect_checks(agent)
        if not detected and agent not in self._warned_no_checks:
            self._warned_no_checks.add(agent)
            logger.warning("plugin=<%s> | verify='auto' found no test command, no checks will run", self.name)
        return detected

    async def _run_check(self, agent: Agent, command: str) -> _CheckResult:
        try:
            result = await agent.sandbox.execute(command, timeout=self._check_timeout)
        except SandboxTimeoutError:
            return _CheckResult(command, None, f"timed out after {self._check_timeout:g}s")
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
