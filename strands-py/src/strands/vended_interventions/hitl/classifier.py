"""Built-in LLM risk classifier for the HumanInTheLoop handler.

Uses an inner agent with structured output to evaluate whether a tool call
requires human approval based on risk criteria.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field

from ...hooks.events import BeforeToolCallEvent
from ...models import Model


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

    Args:
        system_prompt: Risk criteria prompt. Defaults to a general-purpose risk prompt.
        model: Model for risk evaluation. Defaults to the parent agent's model.
    """

    system_prompt: str | None = field(default=None)
    model: Model | None = field(default=None)


_DEFAULT_SYSTEM_PROMPT = """You are a risk evaluator for an AI agent's tool calls. Your job is to decide whether \
each tool call requires human approval before executing.

## When to require approval

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

Note: even read-only operations that access credentials, secrets, PII, or financial data still require approval.

## Instructions

Evaluate the tool name and its input arguments. Consider what could go wrong if this specific call executes \
with these specific arguments. When uncertain, require approval.

Keep your reason under 10 words — it is shown to a human in a CLI prompt."""


class _RiskDecision(BaseModel):
    """Structured output schema for the inner classification agent."""

    requires_approval: bool = Field(description="Whether this tool call requires human approval before executing")
    reason: str = Field(description="Brief reason (under 10 words) why approval is or is not required")


def _create_llm_risk_classifier(config: LLMClassifierConfig | None = None) -> HumanInTheLoopClassifier:
    """Create the built-in LLM risk classifier.

    Args:
        config: Optional configuration for the classifier.

    Returns:
        A classifier function that asks a model to evaluate risk.
    """
    system_prompt = (config.system_prompt if config else None) or _DEFAULT_SYSTEM_PROMPT
    configured_model = config.model if config else None

    async def classifier(event: BeforeToolCallEvent, **kwargs: Any) -> ClassifierResult:
        from ...event_loop._auxiliary_model_call import auxiliary_structured_output

        model = configured_model or event.agent.model
        if not model:
            raise ValueError(
                "LLM risk classifier has no model — pass `model` in "
                "`LLMClassifierConfig(model=...)`, or ensure the parent agent has a model."
            )

        tool_use = event.tool_use
        prompt = (
            f"Should this tool call require human approval?\n\n"
            f"Tool: {tool_use['name']}\n"
            f"Input: {json.dumps(tool_use['input'], indent=2)}"
        )
        decision = await auxiliary_structured_output(
            model,
            _RiskDecision,
            prompt,
            source="hitl_classifier",
            agent=event.agent,
            system_prompt=system_prompt,
            # A shallow copy, so hooks can't add or remove keys in the live invocation_state.
            invocation_state=dict(event.invocation_state),
        )

        return ClassifierResult(
            requires_human_in_the_loop=decision.requires_approval,
            reason=decision.reason,
        )

    return classifier
