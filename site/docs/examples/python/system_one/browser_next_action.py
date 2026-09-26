#!/usr/bin/env python3
"""
# Browser use: pick the next element, detect the goal, escalate when unsure

Use case: driving computer and browser use. Code extracts the actionable elements from the page
(here a fixed accessibility snapshot, so the sample needs no browser). One request asks a Choice
over the element ids plus two YesNo questions. Confident steps act directly; anything else goes
to the reasoning computer-use agent, the "System Two" escalation path.

"Select, don't generate": the model never writes a selector, it picks one of the ids code found.

Usage:
    python browser_next_action.py                # Jev (TYPESAFE_API_KEY)
    python browser_next_action.py --engine kev   # self-hosted Kev (--kev-url, default KEV_BASE_URL)
    python browser_next_action.py --engine llm   # same questions on an LLM
"""

from __future__ import annotations

import asyncio

from _common import Report, decision_model, parse_args
from pydantic import BaseModel
from strands import Agent
from strands.experimental.decisions import Choice, YesNo
from strands.models import BedrockModel

CONFIDENCE_FLOOR = 0.7

PAGES = [
    {
        "goal": "Add a USB-C cable under $15 to the cart",
        "page": "search results for 'usb-c cable'",
        "elements": {
            "e1": "link 'Anker USB-C Cable 6ft - $12.99'",
            "e2": "button 'Add to cart' beside 'Anker USB-C Cable 6ft - $12.99'",
            "e3": "button 'Add to cart' beside 'Apple USB-C Cable - $19.00'",
            "e4": "input 'Search'",
        },
        "expected": ("e2", False),
    },
    {
        "goal": "Add a USB-C cable under $15 to the cart",
        "page": "cart: 'Anker USB-C Cable 6ft - $12.99' x1, subtotal $12.99",
        "elements": {"e1": "button 'Checkout'", "e2": "button 'Remove'", "e3": "link 'Continue shopping'"},
        "expected": ("none", True),
    },
    {
        "goal": "Change the account email to ops@example.com",
        "page": "settings: 'Email: old@example.com'",
        "elements": {
            "e1": "button 'Edit' beside 'Email'",
            "e2": "button 'Edit' beside 'Phone'",
            "e3": "link 'Delete account'",
        },
        "expected": ("e1", False),
    },
    {
        # Two equally good options: a calibrated model splits its answer between them, so the step goes to
        # the computer-use agent. Either room is acceptable.
        "goal": "Book the 9am meeting room",
        "page": "rooms",
        "elements": {"e1": "button 'Book' in row 'Room A 9:00'", "e2": "button 'Book' in row 'Room B 9:00'"},
        "expected": ({"e1", "e2"}, False),
    },
]


class NextStep(BaseModel):
    element: str


def computer_use_agent(model_id: str) -> Agent:
    """The System Two path. In a real app this agent drives the browser with tools; here it only picks."""
    return Agent(
        model=BedrockModel(model_id=model_id),
        system_prompt="You drive a web browser. Pick the element id to click next, or 'none' if no click helps.",
        callback_handler=None,
    )


async def escalate(agent: Agent, state: dict) -> str:
    agent.messages.clear()
    result = await agent.invoke_async(str(state), structured_output_model=NextStep)
    return result.structured_output.element


def questions(elements: dict[str, str]) -> dict:
    return {
        "action": Choice(
            "Which element in `elements` should be clicked next to make progress toward `goal` on `page`?",
            options={**{key: None for key in elements}, "none": "No element is needed or none helps"},
        ),
        "goal_reached": YesNo("Is `goal` already achieved on `page`?"),
    }


async def main() -> None:
    args = parse_args(__doc__.splitlines()[1])
    engine = decision_model(args)
    report = Report(args.engine, engine)
    system_two = computer_use_agent(args.llm_model)
    escalations = 0
    print(f"browser next action ({args.engine})")
    for page in PAGES:
        state = {key: page[key] for key in ("goal", "page", "elements")}
        response = await report.time(lambda state=state: engine.ask(state, questions(state["elements"])))
        action, reached = response["action"], response["goal_reached"]
        # Ask both together: a reached goal means stop, whatever the action distribution says.
        # An uncalibrated engine has no confidence to gate on, so it always takes the fast path.
        confident = action.confidence is None or action.confidence >= CONFIDENCE_FLOOR
        path = "fast"
        if reached.probability >= 0.9:
            decision = "none"
        elif confident:
            decision = action.choice
        else:
            path, escalations = "escalated", escalations + 1
            decision = await escalate(system_two, state)
        expected_action, expected_reached = page["expected"]
        detail = f"confidence={action.confidence} path={path}"
        report.check(page["page"][:40], expected_action, decision, detail)
        report.check("  goal reached", expected_reached, reached.probability >= 0.5, f"p={reached.probability:.2f}")
    report.summary()
    print(f"escalated to the computer-use agent: {escalations}/{len(PAGES)} steps")


if __name__ == "__main__":
    asyncio.run(main())
