"""Persistent model-spend enforcement for Strands agents."""

import asyncio
import logging
from typing import TYPE_CHECKING

from strands.hooks import AfterInvocationEvent, BeforeModelCallEvent
from strands.interventions import Deny
from strands.plugins import Plugin
from strands.storage import LocalFileStorage, Storage
from pathlib import Path

from strands_harness.plugins.budget.aws_pricing import fetch_aws_rates
from strands_harness.plugins.budget.budget_state import BudgetManager
from strands_harness.plugins.budget.intervention import BudgetIntervention

if TYPE_CHECKING:
    from strands.agent.agent import Agent

logger = logging.getLogger(__name__)


class BudgetPlugin(Plugin):
    """Persist model-call costs and block calls after a budget is exhausted.

    The plugin uses the attached agent's session ID as the budget key. A stable
    session ID reuses the same budget across agent instances. Without session
    management, Strands generates an ID that remains stable for the lifetime of
    one agent instance.

    The plugin bills a model only when its runtime model ID matches an entry in
    ``custom_rates`` or the optional AWS pricing data. Rate values are USD per
    input and output token.

    Example:
        ```python
        from strands_harness import create_harness
        from strands_harness.plugins import BudgetPlugin

        model_id = "qwen.qwen3-coder-next"
        budget = BudgetPlugin(
            budget=10.0,
            custom_rates={model_id: (0.22 / 1_000_000, 1.80 / 1_000_000)},
        )
        agent = create_harness(
            model=model_id,
            session={"id": "my-project"},
            plugins=[budget],
        )
        ```
    """

    name = "budget-plugin"

    def __init__(
        self,
        budget: float | None = None,
        storage: Storage | None = None,
        custom_rates: dict[str, tuple[float, float]] | None = None,
        use_aws_pricing: bool = False,
        aws_region: str = "us-east-1",
    ) -> None:
        """Initialize budget enforcement.

        Args:
            budget: Budget limit in USD. A value sets or updates the persisted
                limit when the plugin attaches. ``None`` leaves an existing
                limit unchanged and creates no limit when state is absent.
            storage: Storage backend for budget state. Defaults to local files
                under ``.agent``.
            custom_rates: Maps exact model IDs or model ID substrings to
                ``(input_rate, output_rate)`` in USD per token. Exact matches
                take precedence, followed by the longest substring match.
            use_aws_pricing: Fetch Amazon Bedrock on-demand token rates from the
                AWS Price List API when the plugin attaches. Requires the
                read-only ``pricing:GetProducts`` permission.
            aws_region: Amazon Bedrock region used to filter pricing data.
        """
        super().__init__()

        if budget is not None and not (custom_rates or use_aws_pricing):
            logger.warning(
                "budget=<%s> | no pricing source configured, model calls will not be billed",
                budget,
            )

        self.manager = BudgetManager(storage=storage)
        self._budget = budget
        self._custom_rates = custom_rates
        self._use_aws_pricing = use_aws_pricing
        self._aws_region = aws_region
        self._session_id: str | None = None
        self._intervention: BudgetIntervention | None = None

    @property
    def session_id(self) -> str | None:
        """Return the agent session ID after the plugin attaches."""
        return self._session_id

    async def init_agent(self, agent: "Agent") -> None:
        """Resolve configuration and register the budget hooks on an agent."""
        
        
        self._session_id = agent.session_id
        base_dir = Path(".agent")
        session_path = base_dir / "sessions" / "session" / self._session_id
        logger.info("Session '%s' uses storage dir: %s", self._session_id, session_path)
        agent_session_storage = LocalFileStorage(session_path)
        self.manager = BudgetManager(storage=agent_session_storage)

        rates = self._custom_rates
        if self._use_aws_pricing:
            aws_rates = await asyncio.to_thread(fetch_aws_rates, self._aws_region)
            rates = {**aws_rates, **(self._custom_rates or {})}

        self._intervention = BudgetIntervention(self.manager, self._session_id, rates)

        if self._budget is not None:
            state = await self.manager.load(self._session_id)
            if state is None or state.total_budget != self._budget:
                await self.manager.set_budget(self._session_id, self._budget)
                logger.info(
                    "session_id=<%s>, budget=<%.5f> | budget limit set",
                    self._session_id,
                    self._budget,
                )

        agent.add_hook(self._before_model, BeforeModelCallEvent)
        agent.add_hook(self._after_invocation, AfterInvocationEvent)

    async def _before_model(self, event: BeforeModelCallEvent) -> None:
        """Bill pending usage and cancel a call when its budget is exhausted."""
        assert self._intervention is not None
        try:
            decision = await self._intervention.before_model_call(event)
        except Exception:
            logger.exception("budget check failed, blocking model call")
            event.cancel = "Budget check failed; model call blocked."
            return
        if isinstance(decision, Deny):
            event.cancel = decision.reason

    async def _after_invocation(self, event: AfterInvocationEvent) -> None:
        """Bill usage from the final model call in an agent invocation."""
        assert self._intervention is not None
        try:
            await self._intervention.record_usage(event.agent)
        except Exception:
            logger.exception("final model-call usage could not be recorded")
