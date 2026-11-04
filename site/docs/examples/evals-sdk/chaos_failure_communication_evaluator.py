import asyncio
import logging
from typing import Any

from pydantic import BaseModel, Field

from strands import Agent
from strands_evals.chaos import ChaosCase, ChaosExperiment, ChaosPlugin, Timeout, NetworkError
from strands_evals.eval_task_handler import TracedHandler, eval_task
from strands_evals.evaluators.chaos import FailureCommunicationEvaluator
from strands_evals.simulation import ToolSimulator

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

tool_simulator = ToolSimulator()

class FlightSearchResponse(BaseModel):
    flights: list[dict[str, Any]] = Field(default_factory=list)
    total_results: int = Field(default=0)
    status: str = Field(default="success")

class BookFlightResponse(BaseModel):
    booking_id: str = Field(default="")
    flight_id: str = Field(default="")
    status: str = Field(default="success")
    message: str = Field(default="")

@tool_simulator.tool(output_schema=FlightSearchResponse)
def search_flights(origin: str, destination: str, date: str) -> dict[str, Any]:
    """Search for available flights between two cities on a given date."""
    pass

@tool_simulator.tool(output_schema=BookFlightResponse)
def book_flight(flight_id: str) -> dict[str, Any]:
    """Book a specific flight by its flight ID."""
    pass

chaos_plugin = ChaosPlugin()

# Two cases that test communication quality:
# 1. Search times out — agent must inform user about the failure
# 2. Both tools fail — agent must communicate multiple failures clearly
chaos_cases = [
    ChaosCase(
        name="search_timeout",
        input="Find me a flight from SFO to JFK on May 20 and book the cheapest one.",
        effects={"tool_effects": {"search_flights": [Timeout(error_message="Tool call timed out after 30s")]}},
    ),
    ChaosCase(
        name="all_tools_down",
        input="Search for flights from Seattle to Tokyo next Tuesday and book one.",
        effects={
            "tool_effects": {
                "search_flights": [NetworkError(error_message="DNS resolution failed")],
                "book_flight": [NetworkError(error_message="Connection refused")],
            },
        },
    ),
]

_search_tool = tool_simulator.get_tool("search_flights")
_book_tool = tool_simulator.get_tool("book_flight")

@eval_task(TracedHandler())
def travel_agent_task(case: ChaosCase):
    """Run the travel agent under chaos and return output + trajectory."""
    logger.info(f"\n{'─'*60}")
    logger.info(f"  Case: {case.name}")
    logger.info(f"  User: {case.input}")
    logger.info(f"{'─'*60}")

    return Agent(
        system_prompt=(
            "You are a travel booking assistant. Use the available tools to complete "
            "the user's request. Today's date is May 18, 2025.\n\n"
            "If a tool fails or returns an error:\n"
            "- Acknowledge the failure honestly to the user\n"
            "- Explain what went wrong in plain language\n"
            "- Suggest next steps (retry later, try alternative)\n"
            "- Do NOT hallucinate successful results"
        ),
        tools=[_search_tool, _book_tool],
        plugins=[chaos_plugin],
        callback_handler=None,
        trace_attributes={"gen_ai.conversation.id": case.session_id, "session.id": case.session_id},
    )

experiment = ChaosExperiment(
    cases=chaos_cases,
    evaluators=[FailureCommunicationEvaluator()],
)

async def main():
    report = await experiment.run_evaluations_async(task=travel_agent_task, max_workers=10)
    report.run_display()

asyncio.run(main())
