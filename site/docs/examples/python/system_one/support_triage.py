#!/usr/bin/env python3
"""
# Support triage: a System One model as the front door and as a graph router

Use case: dynamic multi-agent routing and handoffs.

Placement (a), front door: a ``DecisionAgent`` sees every incoming message first, dispatches
confident requests straight to a specialist, and hands anything uncertain or multi-issue to a
general reasoning agent. Placement (b), subagent: the same schema drives a ``Graph`` through
``when_choice`` / ``when_below`` edges.

Usage:
    python support_triage.py                # Jev (TYPESAFE_API_KEY)
    python support_triage.py --engine kev   # self-hosted Kev (--kev-url, default KEV_BASE_URL)
    python support_triage.py --engine llm   # same schema on an LLM (Amazon Bedrock)
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Literal

from _common import Report, decision_model, parse_args
from pydantic import BaseModel
from strands import Agent
from strands.experimental.decisions import Choice, DecisionAgent, YesNo, when_below, when_choice
from strands.multiagent import GraphBuilder


class Triage(BaseModel):
    department: Annotated[
        Literal["billing", "technical", "account"] | None,
        Choice(
            "Which team should handle the customer's message?",
            options={
                "billing": "Charges, invoices, refunds, payment methods",
                "technical": "Bugs, outages, errors, integrations",
                "account": "Login, passwords, MFA, profile settings",
            },
        ),
    ]
    multi_issue: Annotated[bool, YesNo("Does the message raise more than one independent problem?")]


CASES = [
    ("You billed my card twice for the March invoice.", "billing"),
    ("The dashboard throws a 500 error whenever I export a report.", "technical"),
    ("I reset my password but the MFA code never arrives.", "account"),
    # Two independent issues: a calibrated model should be unsure, so the request goes to the fallback.
    ("I was double-charged AND I can't log in to fix it.", "fallback"),
]


def specialist(name: str) -> Agent:
    # In a real app these are full agents with tools; here each replies with its name.
    return Agent(system_prompt=f"Reply only with the word '{name}'.", name=name, callback_handler=None)


def canned(name: str):
    """A code route: no LLM call at all for the confident, well-understood path.

    A message with several independent problems goes to the fallback even when the department is clear:
    one specialist cannot resolve all of it.
    """
    return lambda decision, prompt: "fallback" if decision.output.multi_issue else name


async def front_door(engine, report: Report) -> None:
    support = DecisionAgent(
        engine,
        Triage,
        route_on="department",
        routes={name: canned(name) for name in ("billing", "technical", "account")},
        # Only a calibrated engine may gate on confidence; the LLM engine routes on its answer alone.
        min_confidence=0.6 if engine.calibrated else None,
        fallback=canned("fallback"),
    )
    print(f"front door ({report.engine})")
    for message, expected in CASES:
        result = await report.time(lambda message=message: support.invoke_async(message))
        answer = result.state["decision"].answers["department"]
        report.check(message[:48], expected, str(result).strip(), f"confidence={answer.confidence}")


async def graph_router(engine) -> None:
    builder = GraphBuilder()
    builder.add_node(DecisionAgent(engine, Triage, name="router"), "router")
    for name in ("billing", "technical", "account", "general"):
        builder.add_node(specialist(name), name)
    for name in ("billing", "technical", "account"):
        builder.add_edge("router", name, condition=when_choice("router", "department", name, min_confidence=0.6))
    builder.add_edge("router", "general", condition=when_below("router", "department", 0.6))
    builder.set_entry_point("router")

    result = await builder.build().invoke_async(CASES[0][0])
    print(f"\ngraph: nodes run = {sorted(result.results)}")


async def main() -> None:
    args = parse_args(__doc__.splitlines()[1])
    engine = decision_model(args)
    report = Report(args.engine, engine)
    await front_door(engine, report)
    report.summary()
    if engine.calibrated:
        await graph_router(engine)


if __name__ == "__main__":
    asyncio.run(main())
