"""LLM-based steering handler that uses an LLM to provide contextual guidance."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from .....models import Model
from .....types.tools import ToolUse
from ...context_providers.ledger_provider import LedgerProvider
from ...core.action import Guide, Interrupt, Proceed, ToolSteeringAction
from ...core.context import SteeringContextProvider
from ...core.handler import SteeringHandler
from .mappers import DefaultPromptMapper, LLMPromptMapper

if TYPE_CHECKING:
    from .....agent import Agent

logger = logging.getLogger(__name__)


class _LLMSteering(BaseModel):
    """Structured output model for LLM steering decisions."""

    decision: Literal["proceed", "guide", "interrupt"] = Field(
        description="Steering decision: 'proceed' to continue, 'guide' to provide feedback, 'interrupt' for human input"
    )
    reason: str = Field(description="Clear explanation of the steering decision and any guidance provided")


class LLMSteeringHandler(SteeringHandler):
    """Steering handler that uses an LLM to provide contextual guidance.

    Uses natural language prompts to evaluate tool calls and provide
    contextual steering guidance to help agents navigate complex workflows.
    """

    def __init__(
        self,
        system_prompt: str,
        prompt_mapper: LLMPromptMapper | None = None,
        model: Model | None = None,
        context_providers: list[SteeringContextProvider] | None = None,
    ):
        """Initialize the LLMSteeringHandler.

        Args:
            system_prompt: System prompt defining steering guidance rules
            prompt_mapper: Custom prompt mapper for evaluation prompts
            model: Optional model override for steering evaluation
            context_providers: List of context providers for populating steering context.
                Defaults to [LedgerProvider()] if None. Pass an empty list to disable
                context providers.
        """
        providers: list[SteeringContextProvider] = (
            [LedgerProvider()] if context_providers is None else context_providers
        )
        super().__init__(context_providers=providers)
        self.system_prompt = system_prompt
        self.prompt_mapper = prompt_mapper or DefaultPromptMapper()
        self.model = model

    async def steer_before_tool(self, *, agent: Agent, tool_use: ToolUse, **kwargs: Any) -> ToolSteeringAction:
        """Provide contextual guidance for tool usage.

        Args:
            agent: The agent instance
            tool_use: The tool use object with name and arguments
            **kwargs: Additional keyword arguments for steering evaluation

        Returns:
            SteeringAction indicating how to guide the tool execution
        """
        # Generate steering prompt
        prompt = self.prompt_mapper.create_steering_prompt(self.steering_context, tool_use=tool_use)

        from .....event_loop._auxiliary_model_call import auxiliary_structured_output

        llm_result = await auxiliary_structured_output(
            self.model or agent.model,
            _LLMSteering,
            prompt,
            source="steering",
            agent=agent,
            system_prompt=self.system_prompt,
        )

        # Convert LLM decision to steering action
        match llm_result.decision:
            case "proceed":
                return Proceed(reason=llm_result.reason)
            case "guide":
                return Guide(reason=llm_result.reason)
            case "interrupt":
                return Interrupt(reason=llm_result.reason)
            case _:
                logger.warning("decision=<%s> | unknown llm decision, defaulting to proceed", llm_result.decision)  # type: ignore[unreachable]
                return Proceed(reason="Unknown LLM decision, defaulting to proceed")
