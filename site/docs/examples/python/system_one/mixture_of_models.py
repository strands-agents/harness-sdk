#!/usr/bin/env python3
"""
# Mixture of models: a System One model picks the model tier per request

Use case: model selection. ``DecisionStrategy`` plugs into ``ModelRouter``: one Choice over the
candidates' descriptions picks the least capable model that can handle the request. Below
``min_confidence`` it declines, and the router serves its first (safe default) candidate.

Placement: embedded strategy, the agent never sees the decision.

Usage:
    python mixture_of_models.py                # Jev (TYPESAFE_API_KEY) + Amazon Bedrock candidates
    python mixture_of_models.py --engine kev   # self-hosted Kev classifies instead of Jev
    python mixture_of_models.py --engine llm   # Haiku classifies instead of Jev
"""

from __future__ import annotations

import asyncio

from _common import Report, decision_model, parse_args
from strands import Agent
from strands.experimental.decisions import DecisionStrategy
from strands.models import BedrockModel, ModelRouter, RoutingCandidate, RoutingContext

ROUTINE = "us.amazon.nova-micro-v1:0"
COMPLEX = "us.anthropic.claude-sonnet-4-6"

CASES = [
    ("What is the capital of Australia?", ROUTINE),
    ("Summarise this sentence in five words: the meeting moved to Thursday at noon.", ROUTINE),
    ("Prove that there are infinitely many primes, then write the proof in Lean 4.", COMPLEX),
    ("Design a sharded rate limiter for 50k RPS with exactly-once accounting; justify each tradeoff.", COMPLEX),
]


def router(strategy: DecisionStrategy) -> ModelRouter:
    return ModelRouter(
        models=[
            # First candidate is the default when the strategy declines, so make it the capable one.
            RoutingCandidate(
                BedrockModel(model_id=COMPLEX, max_tokens=512),
                name="complex",
                description="Multi-step reasoning, proofs, code generation, system design",
            ),
            RoutingCandidate(
                BedrockModel(model_id=ROUTINE, max_tokens=512),
                name="routine",
                description="Direct factual questions, short summaries, extraction",
            ),
        ],
        strategy=strategy,
    )


async def main() -> None:
    args = parse_args(__doc__.splitlines()[1])
    engine = decision_model(args)
    strategy = DecisionStrategy(engine, min_confidence=0.7 if engine.calibrated else None)
    shared = router(strategy)
    report = Report(args.engine, engine)
    print(f"mixture of models ({args.engine})")
    for prompt, expected in CASES:
        context = _context(shared, prompt)
        candidate = await report.time(lambda context=context: strategy.select(context))
        chosen = (candidate or shared.candidates[0]).model.config["model_id"]
        report.check(prompt[:48], expected, chosen, "(declined -> default)" if candidate is None else "")
    report.summary()

    agent = Agent(model=shared, callback_handler=None)
    print(f"\nagent answer via routed model: {str(agent(CASES[0][0])).strip()[:60]}")


def _context(shared: ModelRouter, prompt: str) -> RoutingContext:
    return RoutingContext(
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        system_prompt=None,
        tool_specs=[],
        candidates=shared.candidates,
        invocation_state={},
    )


if __name__ == "__main__":
    asyncio.run(main())
