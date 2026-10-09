#!/usr/bin/env python3
"""Route support messages to specialist agents with a DecisionModel.

A ``DecisionAgent`` decides which team handles each message, then hands the message to that team's agent. A message
the decision model is unsure about goes to the general agent. The same schema then drives a ``Graph``.

Usage:
    python support_triage.py               # Jev decides (needs TYPESAFE_API_KEY); agents run on Amazon Bedrock
    python support_triage.py --decider llm # an LLM decides instead (answers carry no confidence)
"""

import argparse
from typing import Annotated, Literal

from strands import Agent
from strands.experimental.decisions import (
    DECISION_STATE_KEY,
    Choice,
    DecisionAgent,
    DecisionSchema,
    LLMDecisionModel,
    when_below,
    when_choice,
)
from strands.models import BedrockModel, SystemOneDecisionModel
from strands.multiagent import GraphBuilder

MODEL_ID = "global.anthropic.claude-sonnet-5-5"
MIN_CONFIDENCE = 0.6  # illustrative: tune on your own traffic

MESSAGES = [
    "You billed my card twice for the March invoice.",
    "The dashboard throws a 500 error whenever I export a report.",
    "I reset my password but the MFA code never arrives.",
    "I was double-charged and now I can't log in to fix it.",  # two teams: the decider should be unsure
]


class Triage(DecisionSchema):
    department: Annotated[
        Literal["billing", "technical", "account"],
        Choice(
            "Which team should handle the customer's message?",
            options={
                "billing": "Charges, invoices, refunds",
                "technical": "Bugs, outages, errors",
                "account": "Login, passwords, MFA",
            },
        ),
    ]


def agent(team: str) -> Agent:
    return Agent(
        name=team,
        model=BedrockModel(model_id=MODEL_ID),
        system_prompt=f"You are the {team} support agent. Start with '[{team}]', then reply in one sentence.",
        callback_handler=None,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--decider", choices=["jev", "llm"], default="jev")
    args = parser.parse_args()
    decider = SystemOneDecisionModel() if args.decider == "jev" else LLMDecisionModel(BedrockModel(model_id=MODEL_ID))

    for message in MESSAGES:
        # Front door: decide, then hand the message to the chosen team's agent. New agents per message, so each
        # customer starts a fresh conversation.
        support = DecisionAgent(
            decider,
            Triage,
            route_on="department",
            routes={team: agent(team) for team in ("billing", "technical", "account")},
            min_confidence=MIN_CONFIDENCE,  # below this, or with no confidence, the message goes to the fallback
            fallback=agent("general"),
        )
        result = support(message)
        decision = result.state[DECISION_STATE_KEY]
        answer = decision.answers["department"]
        print(f"\n> {message}")
        print(f"  decision: {answer.choice}, confidence {answer.confidence}, {decision.usage['totalTokens']} tokens")
        print(f"  reply ({result.metrics.accumulated_usage['totalTokens']} tokens): {str(result).strip()}")

    # Graph: the same decision as a node; edges read it back.
    builder = GraphBuilder()
    builder.add_node(DecisionAgent(decider, Triage, name="router"), "router")
    for team in ("billing", "technical", "account", "general"):
        builder.add_node(agent(team), team)
    for team in ("billing", "technical", "account"):
        builder.add_edge(
            "router", team, condition=when_choice("router", "department", team, min_confidence=MIN_CONFIDENCE)
        )
    builder.add_edge("router", "general", condition=when_below("router", "department", MIN_CONFIDENCE))
    builder.set_entry_point("router")
    graph = builder.build()

    result = graph(MESSAGES[-1])
    ran = [node for node in result.results if node != "router"]
    print(f"\ngraph: {MESSAGES[-1]!r} -> {ran}")


if __name__ == "__main__":
    main()
