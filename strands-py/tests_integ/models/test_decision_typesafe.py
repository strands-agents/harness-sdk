"""Live System One decision tests.

Jev runs only when ``TYPESAFE_API_KEY`` is set; Kev runs only when ``KEV_BASE_URL`` points at a running Kev server
(``KEV_API_KEY`` is sent as the bearer when the server requires one).
"""

import os
from typing import Annotated, Literal

import pytest
from pydantic import BaseModel

from strands.experimental.decisions import Choice, Score, YesNo


class Triage(BaseModel):
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


def _jev():
    from strands.models import TypeSafeDecisionModel

    return TypeSafeDecisionModel()


def _kev():
    from strands.models import TypeSafeDecisionModel
    from strands.models.typesafe import KEV_MAX_STATE_PLUS_QUESTION_TOKENS

    return TypeSafeDecisionModel(
        base_url=os.environ["KEV_BASE_URL"],
        api_key=os.environ.get("KEV_API_KEY") or None,
        model_id="kev-latest",
        max_state_plus_question_tokens=KEV_MAX_STATE_PLUS_QUESTION_TOKENS,
        max_request_tokens=None,
        client_args={"timeout": 120},  # CPU-served checkpoints can take tens of seconds per request
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("make_model", "model_prefix"),
    [
        pytest.param(
            _jev,
            "jev-",
            marks=pytest.mark.skipif(not os.environ.get("TYPESAFE_API_KEY"), reason="TYPESAFE_API_KEY not set"),
            id="jev",
        ),
        pytest.param(
            _kev,
            "kev-",
            marks=pytest.mark.skipif(not os.environ.get("KEV_BASE_URL"), reason="KEV_BASE_URL not set"),
            id="kev",
        ),
    ],
)
async def test_decide_live(make_model, model_prefix):
    decision = await make_model().decide(Triage, state=STATE)

    assert decision.output.department == "billing"
    assert decision.answers["refund_requested"].probability > 0.5
    assert decision.answers["department"].confidence is not None
    assert decision.model_id and decision.model_id.startswith(model_prefix)
    assert decision.usage["inputTokens"] > 0
