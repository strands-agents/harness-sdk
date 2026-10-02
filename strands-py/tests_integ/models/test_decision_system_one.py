"""Live System One decision test against TypeSafe's hosted Jev. Runs only when ``TYPESAFE_API_KEY`` is set."""

import os
from typing import Annotated, Literal

import pytest

from strands.experimental.decisions import Choice, DecisionSchema, Score, YesNo


class Triage(DecisionSchema):
    department: Annotated[
        Literal["billing", "technical", "sales"],
        Choice(
            "Which team should handle `ticket`?",
            options={"billing": "Payments, invoices, refunds", "technical": "Bugs, outages", "sales": "Pricing"},
        ),
    ]
    refund_requested: Annotated[bool, YesNo("Does `ticket` ask for money back?")]
    frustration: Annotated[float, Score("How frustrated is the customer?", levels=["calm", "frustrated", "furious"])]


STATE = {"ticket": "You charged my card twice for the March invoice. Refund the duplicate now!"}


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get("TYPESAFE_API_KEY"), reason="TYPESAFE_API_KEY not set")
async def test_decide_live():
    from strands.models import SystemOneDecisionModel

    decision = await SystemOneDecisionModel().decide(Triage, state=STATE)

    assert decision.output.department == "billing"
    assert decision.answers["refund_requested"].probability > 0.5
    assert decision.answers["department"].confidence is not None
    assert decision.model_id and decision.model_id.startswith("jev-")
    assert decision.usage["inputTokens"] > 0
