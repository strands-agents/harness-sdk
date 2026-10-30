"""Built-in risk classifiers for the HumanInTheLoop handler.

The LLM classifier uses an inner agent with structured output; the decision model
classifier asks any ``DecisionModel`` a single boolean question. Both evaluate
whether a tool call requires human approval against the same risk criteria.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from ...agent.invocation_context import _create_auxiliary_invocation_context
from ...decisions import DecisionModel, Uncertain
from ...hooks.events import BeforeToolCallEvent
from ...models import Model

logger = logging.getLogger(__name__)


@dataclass
class ClassifierResult:
    """Result from a classifier evaluation."""

    requires_human_in_the_loop: bool
    reason: str | None = field(default=None)


@runtime_checkable
class HumanInTheLoopClassifier(Protocol):
    """Callable (sync or async) that decides whether a tool call requires human approval."""

    def __call__(self, event: BeforeToolCallEvent, **kwargs: Any) -> ClassifierResult | Awaitable[ClassifierResult]:
        """Evaluate whether a tool call requires human approval.

        Args:
            event: The tool call event under evaluation.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            ClassifierResult indicating whether approval is required.
        """
        ...


@dataclass
class LLMClassifierConfig:
    """Configuration for the built-in LLM risk classifier.

    Kept for backwards compatibility. Prefer passing a ``DecisionModel`` as the classifier for new code.

    Args:
        system_prompt: Risk criteria prompt. Defaults to a general-purpose risk prompt.
        model: Model for risk evaluation. Resolution order: this ``model`` > ``agent.aux_model``
            > ``agent.model``.
    """

    system_prompt: str | None = field(default=None)
    model: Model | None = field(default=None)


_RISK_CRITERIA = """## When to require approval

Require approval when the tool call:
- Is destructive or irreversible (deleting data, dropping tables, revoking access)
- Modifies important state in production or shared environments
- Accesses or transmits sensitive data (credentials, PII, financial records)
- Communicates externally (sending emails, posting messages, making payments)
- Has a large blast radius (affecting many records, users, or systems)

## When approval is NOT needed

Do not require approval when the tool call:
- Is read-only AND does not access sensitive data (listing non-sensitive files, querying public data, searching)
- Operates on local or temporary resources
- Has easily reversible effects
- Is scoped to a single non-critical resource

Note: even read-only operations that access credentials, secrets, PII, or financial data still require approval."""

_DEFAULT_SYSTEM_PROMPT = f"""You are a risk evaluator for an AI agent's tool calls. Your job is to decide whether \
each tool call requires human approval before executing.

{_RISK_CRITERIA}

## Instructions

Evaluate the tool name and its input arguments. Consider what could go wrong if this specific call executes \
with these specific arguments. When uncertain, require approval.

Keep your reason under 10 words — it is shown to a human in a CLI prompt."""

_DEFAULT_RISK_QUESTION = f"""Does this AI agent tool call require human approval before executing? Consider what could \
go wrong if this specific call executes with these specific arguments.

{_RISK_CRITERIA}"""


class _RiskDecision(BaseModel):
    """Structured output schema for the inner classification agent."""

    requires_approval: bool = Field(description="Whether this tool call requires human approval before executing")
    reason: str = Field(description="Brief reason (under 10 words) why approval is or is not required")


def _create_llm_risk_classifier(config: LLMClassifierConfig | None = None) -> HumanInTheLoopClassifier:
    """Create the built-in LLM risk classifier.

    Args:
        config: Optional configuration for the classifier.

    Returns:
        A classifier function that uses an inner LLM agent to evaluate risk.
    """
    system_prompt = (config.system_prompt if config else None) or _DEFAULT_SYSTEM_PROMPT
    configured_model = config.model if config else None

    async def classifier(event: BeforeToolCallEvent, **kwargs: Any) -> ClassifierResult:
        from ...agent import Agent

        model = configured_model or event.agent.aux_model
        if not model:
            raise ValueError(
                "LLM risk classifier has no model — pass `model` in "
                "`LLMClassifierConfig(model=...)`, or ensure the parent agent has a model."
            )

        inner = Agent(model=model, system_prompt=system_prompt, callback_handler=None)
        prompt = f"Should this tool call require human approval?\n\n{_format_tool_call(event)}"
        result = await inner.invoke_async(
            prompt,
            structured_output_model=_RiskDecision,
            invocation_context=_create_auxiliary_invocation_context(event.invocation_context),
        )
        decision = result.structured_output
        if not isinstance(decision, _RiskDecision):
            raise ValueError(f"LLM risk classifier produced no structured output (stop_reason={result.stop_reason!r})")

        return ClassifierResult(
            requires_human_in_the_loop=decision.requires_approval,
            reason=decision.reason,
        )

    return classifier


def _create_decision_model_risk_classifier(decision_model: DecisionModel) -> HumanInTheLoopClassifier:
    """Create a risk classifier that asks a ``DecisionModel`` whether a tool call requires approval.

    An ``Uncertain`` answer requires approval and carries its reason. A definite answer carries no reason.

    Args:
        decision_model: The decision model to ask.

    Returns:
        A classifier function backed by the configured decision model.
    """

    async def classifier(event: BeforeToolCallEvent, **kwargs: Any) -> ClassifierResult:
        result = await decision_model.ask(
            _format_tool_call(event),
            {"requires_approval": {"question": _DEFAULT_RISK_QUESTION, "choices": "boolean"}},
            invocation_context=event.invocation_context,
        )
        answer = result.answers["requires_approval"]
        if isinstance(answer, Uncertain):
            return ClassifierResult(requires_human_in_the_loop=True, reason=answer.reason)
        if not isinstance(answer, bool):
            logger.warning(
                "answer=<%r> | decision model returned a non-boolean answer, defaulting to approval required", answer
            )
            return ClassifierResult(requires_human_in_the_loop=True)
        return ClassifierResult(requires_human_in_the_loop=answer)

    return classifier


def _format_tool_call(event: BeforeToolCallEvent) -> str:
    tool_use = event.tool_use
    return f"Tool: {tool_use['name']}\nInput: {json.dumps(tool_use['input'], indent=2)}"
