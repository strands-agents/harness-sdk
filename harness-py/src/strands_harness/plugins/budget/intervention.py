"""Budget checks and token-usage accounting for model calls."""

import logging
from typing import Any

from strands.hooks.events import BeforeModelCallEvent
from strands.interventions import Deny, InterventionHandler, OnError, Proceed

from strands_harness.plugins.budget.budget_state import BudgetManager
from strands_harness.plugins.budget.pricing import estimate_cost

logger = logging.getLogger(__name__)


class BudgetIntervention(InterventionHandler):
    """Record model-call costs and deny calls after a budget is exhausted.

    Strands updates accumulated usage after its after-model hooks run. Before
    each model call, this intervention bills usage from the preceding call and
    then checks the persisted budget. ``BudgetPlugin`` also calls
    ``record_usage`` after an invocation to bill its final model call.

    A model call that crosses the limit completes because its output usage is
    not known in advance. The next model call is denied.
    """

    name = "budget-intervention"

    def __init__(
        self,
        manager: BudgetManager,
        session_id: str,
        rates: dict[str, tuple[float, float]] | None = None,
    ) -> None:
        """Initialize accounting for one session ID.

        Args:
            manager: Budget manager used to load state and record costs.
            session_id: Identifier that keys budget state in storage.
            rates: Maps exact model IDs or model ID substrings to per-token
                ``(input_rate, output_rate)`` values in USD.
        """
        self.manager = manager
        self.session_id = session_id
        self.rates = rates or {}
        self._billed_input_tokens = 0
        self._billed_output_tokens = 0

    @property
    def on_error(self) -> OnError:
        """Deny the model call when a budget check fails."""
        return "deny"

    async def before_model_call(self, event: BeforeModelCallEvent, **kwargs: Any) -> Proceed | Deny:
        """Bill pending usage and return whether the next call may proceed."""
        await self.record_usage(event.agent)
        state = await self.manager.load(self.session_id)
        if state is None:
            return Proceed()
        if not state.is_exhausted():
            return Proceed()

        reason = (
            f"Budget exhausted for session '{self.session_id}': spent ${state.spent:.5f} of ${state.total_budget:.5f}"
        )
        logger.critical(
            "session_id=<%s>, spent=<%.5f>, budget=<%.5f> | budget exhausted",
            self.session_id,
            state.spent,
            state.total_budget,
        )
        return Deny(reason=reason)

    def _find_rates(self, model_id: str) -> tuple[float, float] | None:
        """Return the exact or most-specific substring rate for a model ID."""
        exact = self.rates.get(model_id)
        if exact is not None:
            return exact

        normalized_model_id = model_id.lower()
        matches = [key for key in self.rates if key.lower() in normalized_model_id]
        if not matches:
            return None
        return self.rates[max(matches, key=len)]

    async def record_usage(self, agent: Any) -> None:
        """Record accumulated token usage that has not been billed yet."""
        usage = agent.event_loop_metrics.accumulated_usage
        input_total = usage.get("inputTokens", 0)
        output_total = usage.get("outputTokens", 0)

        if input_total < self._billed_input_tokens or output_total < self._billed_output_tokens:
            self._billed_input_tokens = 0
            self._billed_output_tokens = 0

        new_input = input_total - self._billed_input_tokens
        new_output = output_total - self._billed_output_tokens
        if new_input <= 0 and new_output <= 0:
            return

        model_id = agent.model.get_config().get("model_id")
        if not model_id:
            self._mark_billed(input_total, output_total)
            logger.warning("model ID unavailable, skipping budget charge")
            return

        if not self.rates:
            self._mark_billed(input_total, output_total)
            return

        model_rates = self._find_rates(model_id)
        if model_rates is None:
            self._mark_billed(input_total, output_total)
            logger.warning("model_id=<%s> | no budget rate found, skipping charge", model_id)
            return

        cost = estimate_cost(new_input, new_output, model_rates)
        state = await self.manager.record_cost(
            self.session_id,
            cost,
            f"model call ({model_id})",
            input_tokens=new_input,
            output_tokens=new_output,
        )
        self._mark_billed(input_total, output_total)

        if state is not None:
            logger.debug(
                "session_id=<%s>, cost=<%.8f>, input_tokens=<%d>, output_tokens=<%d>, remaining=<%.8f> "
                "| model call billed",
                self.session_id,
                cost,
                new_input,
                new_output,
                state.remaining,
            )

    def _mark_billed(self, input_tokens: int, output_tokens: int) -> None:
        self._billed_input_tokens = input_tokens
        self._billed_output_tokens = output_tokens
