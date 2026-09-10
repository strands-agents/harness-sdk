"""Iterative-refinement plugin for Strands agents.

Validates the agent's response after each invocation; if it doesn't satisfy
the goal, feeds validator feedback back as a user message and re-enters the
agent loop via ``AfterInvocationEvent.resume``. Loops until validation passes,
``max_attempts`` is reached, or ``timeout`` elapses.

Example:
    ```python
    from strands import Agent
    from strands.vended_plugins.goal import GoalLoop

    # Natural-language goal — judged by an internal Agent built from the host's model.
    concise = GoalLoop(
        goal="At most 3 sentences, accessible to a 10-year-old, no jargon.",
        max_attempts=3,
    )
    agent = Agent(plugins=[concise])
    agent("Explain how rainbows form.")
    print(concise.last_result(agent))
    ```

Example:
    ```python
    # Programmatic validator — pass a callable as `goal` to run your own check.
    def word_count_validator(response, agent):
        text = " ".join(
            block["text"] for block in response["content"] if "text" in block
        )
        words = len(text.split())
        if words <= 50:
            return True
        return {"passed": False, "feedback": f"Too long ({words} words). Cap at 50."}

    word_count = GoalLoop(goal=word_count_validator, max_attempts=5, timeout=30.0)
    ```
"""

from __future__ import annotations

import inspect
import logging
import time
import warnings
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol, runtime_checkable

from ...hooks.events import AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent
from ...plugins import Plugin
from ...types._snapshot import Snapshot
from ...types.content import ContentBlock, Message, Messages
from .judge import JUDGE_SYSTEM_PROMPT, JudgeOutcome, build_judge_prompt

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...models.model import Model

logger = logging.getLogger(__name__)


@dataclass
class ValidationOutcome:
    """Outcome a validator returns."""

    passed: bool
    feedback: str | None = None


ValidatorReturn = bool | ValidationOutcome | dict[str, Any]
"""Return type for programmatic validators.

Booleans are shorthand: True -> pass, False -> fail with no feedback. Use
the dict form ``{"passed": bool, "feedback": str}`` or ``ValidationOutcome``
when you have actionable feedback for the next attempt.
"""


@runtime_checkable
class Validator(Protocol):
    """Programmatic validator callable.

    Must return True, False, a ValidationOutcome, or a dict with ``passed`` and
    optional ``feedback`` keys. May be sync or async.

    The second argument is the host agent — read ``agent.messages`` for the full
    transcript (the same view the built-in NL judge sees), or any other state
    the validator needs.
    """

    def __call__(self, response: Message, agent: Agent, **kwargs: Any) -> ValidatorReturn | Awaitable[ValidatorReturn]:
        """Validate the agent's response."""
        ...


GoalStopReason = Literal["satisfied", "max_attempts", "timeout"]
"""Why a goal run ended."""


@dataclass
class GoalAttempt:
    """Single attempt summary preserved on GoalResult."""

    attempt: int
    passed: bool
    feedback: str | None = None


@dataclass
class GoalResult:
    """Aggregate result of a goal run, exposed via ``GoalLoop.last_result``."""

    passed: bool
    stop_reason: GoalStopReason
    attempts: list[GoalAttempt] = field(default_factory=list)


@dataclass
class JudgeConfig:
    """Tuning for the auto-built judge used when ``goal`` is a natural-language string.

    Harmlessly ignored when ``goal`` is a validator function — no judge is built in that case.

    Attributes:
        model: Model the judge agent uses. Defaults to the host agent's model.
        system_prompt: System prompt for the judge agent. Defaults to JUDGE_SYSTEM_PROMPT.
    """

    model: Model | None = None
    system_prompt: str = JUDGE_SYSTEM_PROMPT


@dataclass
class _RunState:
    """Single source of truth for an in-progress or just-finished goal run."""

    start_time: float
    attempts: list[GoalAttempt] = field(default_factory=list)
    result: GoalResult | None = None
    resumed: bool = False
    initial_snapshot: Snapshot | None = None


# Two GoalLoops on one agent both write event.resume in AfterInvocation — only the
# last callback's value survives, silently breaking the other's retry loop. Guard here.
_agents_with_goal_loop: weakref.WeakSet[Agent] = weakref.WeakSet()


def _default_resume_prompt(feedback: str | None) -> str:
    """Default template for the user message fed to the agent before each retry."""
    if not feedback:
        return (
            "Your previous attempt did not satisfy the goal. Produce a new, corrected "
            "response that fully satisfies it — do not restate or lightly edit the previous attempt."
        )
    return (
        "Your previous attempt did not satisfy the goal.\n\n"
        f"Feedback on what was wrong:\n{feedback}\n\n"
        "Address every point above and produce a new, corrected response that fully satisfies "
        "the goal. Do not restate or lightly edit the previous attempt — fix the specific problems called out."
    )


def _last_assistant_message(messages: Messages) -> Message | None:
    """Find the last assistant message, or None if the model never replied."""
    for message in reversed(messages):
        if message["role"] == "assistant":
            return message
    return None


def _normalize_validator_return(result: ValidatorReturn) -> ValidationOutcome:
    """Coerce the various validator return shapes into a canonical ValidationOutcome."""
    if isinstance(result, bool):
        return ValidationOutcome(passed=result)
    if isinstance(result, ValidationOutcome):
        return result
    # Must be dict — the only remaining type in the union
    return ValidationOutcome(
        passed=result.get("passed", False),
        feedback=result.get("feedback"),
    )


def _finish_run(run: _RunState, stop_reason: GoalStopReason) -> None:
    """Mark a run as complete."""
    run.result = GoalResult(
        passed=stop_reason == "satisfied",
        stop_reason=stop_reason,
        attempts=list(run.attempts),
    )
    run.resumed = False


class GoalLoop(Plugin):
    """Iterative-refinement plugin.

    A single GoalLoop instance can be attached to multiple Agents; per-agent run
    state is keyed off the agent, so concurrent runs on different agents don't
    interfere. Only one GoalLoop is supported per individual agent.

    Args:
        goal: What "done" means for this loop. Either a natural-language goal (str)
            judged by an internal Agent, or a programmatic validator callable.
        judge: Tuning for the auto-built judge (ignored when goal is a callable).
        max_attempts: Maximum number of attempts. Defaults to infinity.
        timeout: Wall-clock budget for the whole run, in seconds. Defaults to infinity.
        name: Plugin name. Defaults to 'strands:goal-loop'.
        preserve_context: Whether to preserve conversation history across retries.
            When True (default), the agent sees its own prior responses and feedback.
            When False, each failed attempt restores the agent's session state to what
            it was immediately before the first model call.
        resume_prompt_template: Builds the user message fed before each retry.
            Receives the trimmed validator feedback (or None). Override to localize
            or retune the framing.
    """

    _name: str

    def __init__(
        self,
        goal: str | Validator,
        *,
        judge: JudgeConfig | None = None,
        max_attempts: int | float = float("inf"),
        timeout: float = float("inf"),
        name: str = "strands:goal-loop",
        preserve_context: bool = True,
        resume_prompt_template: Callable[[str | None], str | list[ContentBlock]] | None = None,
    ) -> None:
        """Initialize the GoalLoop plugin.

        Args:
            goal: Natural-language goal string or programmatic validator callable.
            judge: Tuning for the auto-built NL judge. Ignored when goal is callable.
            max_attempts: Maximum number of attempts before stopping.
            timeout: Wall-clock budget in seconds for the entire run.
            name: Plugin name. Must be unique per agent.
            preserve_context: Whether to keep conversation history across retries.
            resume_prompt_template: Custom template for the retry user message.
        """
        if goal is None:
            raise ValueError("GoalLoop: `goal` is required (a natural-language string or a validator function)")
        if max_attempts < 1:
            raise ValueError(f"max_attempts=<{max_attempts}> | must be at least 1")
        if timeout <= 0:
            raise ValueError(f"timeout=<{timeout}> | must be positive")

        self._name = name

        if isinstance(goal, str):
            self._goal: str | None = goal
            self._validator: Validator | None = None
        else:
            self._goal = None
            self._validator = goal

        judge_config = judge or JudgeConfig()
        self._judge_model = judge_config.model
        self._judge_system_prompt = judge_config.system_prompt
        self._max_attempts = max_attempts
        self._timeout = timeout
        self._preserve_context = preserve_context
        self._resume_prompt_template = resume_prompt_template or _default_resume_prompt
        # Per-agent run state — keyed by agent so one plugin instance can serve many.
        # WeakKeyDictionary lets agents GC normally when the caller drops them.
        self._runs: weakref.WeakKeyDictionary[Agent, _RunState] = weakref.WeakKeyDictionary()

        if self._max_attempts == float("inf") and self._timeout == float("inf"):
            warnings.warn(
                f"{self._name} has no max_attempts or timeout; execution is unbounded",
                stacklevel=2,
            )

        super().__init__()

    @property
    def name(self) -> str:
        """Plugin name."""
        return self._name

    def last_result(self, agent: Agent) -> GoalResult | None:
        """Result of the most recent completed run on ``agent``.

        Returns None if no run has finished on that agent since this plugin was
        constructed, or if a run is still in-flight.
        """
        run = self._runs.get(agent)
        if run is None:
            return None
        return run.result

    def init_agent(self, agent: Agent) -> None:
        """Register hooks on the agent. Called by the plugin registry."""
        if agent in _agents_with_goal_loop:
            raise RuntimeError(
                f"{self._name}: another GoalLoop is already attached to this agent; "
                "only one GoalLoop is supported per agent"
            )
        _agents_with_goal_loop.add(agent)

        validator = self._build_validator(agent)

        def _before_invocation(event: BeforeInvocationEvent) -> None:
            existing = self._runs.get(event.agent)
            if existing and existing.resumed:
                existing.resumed = False
                return
            self._runs[event.agent] = _RunState(start_time=time.monotonic())

        agent.add_hook(_before_invocation, BeforeInvocationEvent)

        if not self._preserve_context:

            def _before_model_call(event: BeforeModelCallEvent) -> None:
                run = self._runs.get(event.agent)
                if run and run.initial_snapshot is None:
                    # Python's "session" preset includes conversation_manager_state (no TS equivalent),
                    # but lacks system_prompt — add it explicitly to match TS snapshot parity.
                    run.initial_snapshot = event.agent.take_snapshot(
                        preset="session", include=["system_prompt"], exclude=["state"]
                    )

            agent.add_hook(_before_model_call, BeforeModelCallEvent)

        async def _after_invocation(event: AfterInvocationEvent) -> None:
            run = self._runs.get(event.agent)
            if not run:
                return

            elapsed = time.monotonic() - run.start_time
            if elapsed >= self._timeout:
                _finish_run(run, "timeout")
                return

            response = _last_assistant_message(event.agent.messages)
            if not response:
                return

            attempt_number = len(run.attempts) + 1

            try:
                outcome = await validator(response)
            except Exception as e:
                logger.warning("plugin=<%s>, error=<%s> | validator threw", self._name, e)
                outcome = ValidationOutcome(passed=False, feedback=f"Validator error: {e}")

            run.attempts.append(
                GoalAttempt(
                    attempt=attempt_number,
                    passed=outcome.passed,
                    feedback=outcome.feedback,
                )
            )

            if outcome.passed:
                _finish_run(run, "satisfied")
                return
            if attempt_number >= self._max_attempts:
                _finish_run(run, "max_attempts")
                return

            if run.initial_snapshot:
                event.agent.load_snapshot(run.initial_snapshot)

            event.resume = self._resume_prompt_template(outcome.feedback.strip() if outcome.feedback else None)
            run.resumed = True

        agent.add_hook(_after_invocation, AfterInvocationEvent)

    def _build_validator(self, host_agent: Agent) -> Callable[[Message], Awaitable[ValidationOutcome]]:
        """Compile the configured goal into the canonical async validator shape."""
        if self._validator:
            validator_fn = self._validator

            async def _fn_validator(response: Message) -> ValidationOutcome:
                result = validator_fn(response, host_agent)
                if inspect.isawaitable(result):
                    result = await result
                return _normalize_validator_return(result)

            return _fn_validator

        goal_description = self._goal
        assert goal_description is not None

        async def _judge_validator(_response: Message) -> ValidationOutcome:
            from ...event_loop._auxiliary_model_call import NoStructuredOutputError, auxiliary_structured_output

            try:
                outcome = await auxiliary_structured_output(
                    self._judge_model or host_agent.model,
                    JudgeOutcome,
                    build_judge_prompt(goal_description, host_agent.messages),
                    source="goal_judge",
                    agent=host_agent,
                    system_prompt=self._judge_system_prompt,
                )
            except NoStructuredOutputError:
                return ValidationOutcome(passed=False, feedback="Judge produced no structured outcome.")
            return ValidationOutcome(passed=outcome.passed, feedback=outcome.feedback)

        return _judge_validator
