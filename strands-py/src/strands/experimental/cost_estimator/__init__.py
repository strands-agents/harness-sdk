"""Cost estimate plugin for Strands Agents (experimental).

Estimates what a request cost in USD from its token usage per model and the list prices bundled in the
third-party ``genai-prices`` package. The estimate is not a bill.

Requires the optional ``cost-estimation`` extra (``pip install 'strands-agents[cost-estimation]'``) and
Python 3.11+; importing this module without it raises :class:`ImportError`.

Example Usage:
    ```python
    from strands import Agent
    from strands.experimental.cost_estimator import GenAIPricesEstimator

    cost = GenAIPricesEstimator()
    agent = Agent(plugins=[cost])

    async for event in agent.stream_async("Compare the three proposals."):
        if "cost_estimate" in event:
            print(event["cost_estimate"].total_usd)
    ```
"""

from .plugin import CostEstimate, CostEstimateEvent, GenAIPricesEstimator, ModelCostEstimate, ModelPrice

__all__ = [
    "CostEstimate",
    "CostEstimateEvent",
    "GenAIPricesEstimator",
    "ModelCostEstimate",
    "ModelPrice",
]
