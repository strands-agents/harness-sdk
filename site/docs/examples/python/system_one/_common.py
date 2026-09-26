"""Shared helpers for the System One samples: engine selection and an accuracy/latency/cost report.

Each sample runs with one of three engines, all answering the same decision schema:

- ``--engine jev``: TypeSafe's hosted Jev (needs ``TYPESAFE_API_KEY``).
- ``--engine kev``: a self-hosted Kev server (https://github.com/jaredpalmer/kev), which speaks the same
  ``/v1/systemone`` API. Start one with ``uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b
  --port 8009`` and point ``--kev-url`` (or ``KEV_BASE_URL``) at it; set ``KEV_API_KEY`` if the server needs one.
- ``--engine llm``: an LLM through ``LLMDecisionModel`` (needs AWS credentials for Amazon Bedrock).

Running more than one is the quickest way to compare them on your own data.
"""

from __future__ import annotations

import argparse
import math
import os
import statistics
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar

from strands.experimental.decisions import DecisionModel, DecisionResponse, DecisionState, LLMDecisionModel, Question
from strands.models import BedrockModel

T = TypeVar("T")

DEFAULT_LLM = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
DEFAULT_KEV_URL = "http://127.0.0.1:8009"

# USD per million tokens (input, output), matching the companion baseline
# (team/designs/0020-system-one-decision-models-baseline.md): AWS Pricing API, us-west-2 on-demand, and
# docs.typesafe.ai/models (Jev bills input only). Retrieved 2026-09-24. Unknown models report no cost:
# a self-hosted Kev has no per-token price, so its cost is the instance time you pay for.
PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "jev": (0.042, 0.0),
    DEFAULT_LLM: (1.10, 5.50),
    "us.amazon.nova-micro-v1:0": (0.035, 0.14),
}


def parse_args(description: str) -> argparse.Namespace:
    """Parse the common ``--engine``, ``--llm-model``, ``--kev-url`` and ``--kev-model`` flags."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--engine", choices=["jev", "kev", "llm"], default="jev")
    parser.add_argument("--llm-model", default=DEFAULT_LLM, help="Bedrock model id for --engine llm")
    parser.add_argument(
        "--kev-url", default=os.environ.get("KEV_BASE_URL", DEFAULT_KEV_URL), help="Kev server for --engine kev"
    )
    parser.add_argument("--kev-model", default="kev-latest", help="model name sent to the Kev server")
    return parser.parse_args()


def usd(model_id: str | None, usage: Mapping[str, int]) -> float:
    """Cost of one request's ``usage``; NaN when the model has no known price."""
    key = "jev" if (model_id or "").startswith("jev") else model_id
    price_in, price_out = PRICES_PER_MTOK.get(key or "", (math.nan, math.nan))
    return (usage.get("inputTokens", 0) * price_in + usage.get("outputTokens", 0) * price_out) / 1e6


class MeteredDecisionModel(DecisionModel):
    """Wrap a decision model and record the cost of every request, wherever an adapter makes it."""

    def __init__(self, inner: DecisionModel) -> None:
        self.inner = inner
        self.decisions = 0
        self.cost = 0.0

    @property
    def calibrated(self) -> bool:
        return self.inner.calibrated

    def get_config(self) -> Any:
        return self.inner.get_config()

    def update_config(self, **config: Any) -> None:
        self.inner.update_config(**config)

    async def _ask(self, state: DecisionState, questions: Mapping[str, Question], **kwargs: Any) -> DecisionResponse:
        response = await self.inner._ask(state, questions, **kwargs)
        self.decisions += 1
        self.cost += usd(response.model_id or self.inner.model_id, response.usage)
        return response


def decision_model(args: argparse.Namespace) -> MeteredDecisionModel:
    """Return the decision engine selected on the command line, metered for the report."""
    if args.engine == "llm":
        return MeteredDecisionModel(LLMDecisionModel(BedrockModel(model_id=args.llm_model)))
    from strands.models import TypeSafeDecisionModel

    if args.engine == "kev":
        from strands.models.typesafe import KEV_MAX_STATE_PLUS_QUESTION_TOKENS

        return MeteredDecisionModel(
            TypeSafeDecisionModel(
                base_url=args.kev_url,
                api_key=os.environ.get("KEV_API_KEY") or None,
                model_id=args.kev_model,
                max_state_plus_question_tokens=KEV_MAX_STATE_PLUS_QUESTION_TOKENS,
                max_request_tokens=None,
                client_args={"timeout": 120},  # generous for CPU-served checkpoints
            )
        )
    return MeteredDecisionModel(TypeSafeDecisionModel())


class Report:
    """Collect per-case latency and correctness; print accuracy, p50/p95 latency, and cost per 1k decisions."""

    def __init__(self, engine: str, metered: MeteredDecisionModel) -> None:
        self.engine = engine
        self.metered = metered
        self.latencies: list[float] = []
        self.correct: list[bool] = []

    async def time(self, call: Callable[[], Awaitable[T]]) -> T:
        started = time.perf_counter()
        value = await call()
        self.latencies.append(time.perf_counter() - started)
        return value

    def check(self, label: str, expected: Any, actual: Any, detail: str = "") -> None:
        """Record one case; ``expected`` may be a set of acceptable answers."""
        ok = actual in expected if isinstance(expected, (set, frozenset)) else expected == actual
        self.correct.append(ok)
        print(f"  [{'ok' if ok else 'MISS'}] {label}: expected={expected!r} got={actual!r} {detail}")

    def summary(self) -> None:
        accuracy = sum(self.correct) / max(1, len(self.correct))
        per_1k = 1000 * self.metered.cost / max(1, self.metered.decisions)
        cost = "no per-token price (self-hosted)" if math.isnan(per_1k) else f"${per_1k:.3f} per 1k decisions"
        print(
            f"\n{self.engine}: {sum(self.correct)}/{len(self.correct)} correct ({accuracy:.0%}), "
            f"p50 {_percentile(self.latencies, 50):.2f}s / p95 {_percentile(self.latencies, 95):.2f}s, "
            f"{cost} ({self.metered.decisions} decisions)"
        )


def _percentile(values: list[float], pct: int) -> float:
    if len(values) < 2:
        return values[0] if values else math.nan
    return statistics.quantiles(values, n=100, method="inclusive")[pct - 1]
