import asyncio
from typing import Any
from enum import Enum
from pydantic import BaseModel, Field

from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.evaluators import GoalSuccessRateEvaluator
from strands_evals.simulation.tool_simulator import ToolSimulator
from strands_evals.mappers import StrandsInMemorySessionMapper
from strands_evals.telemetry import StrandsEvalsTelemetry

# Setup telemetry and tool simulator
telemetry = StrandsEvalsTelemetry().setup_in_memory_exporter()
memory_exporter = telemetry.in_memory_exporter
tool_simulator = ToolSimulator()

# Define tool's output schema
class HVACMode(str, Enum):
    """HVAC operating modes."""
    HEAT = "heat"
    COOL = "cool"
    AUTO = "auto"
    OFF = "off"

class HVACControllerResponse(BaseModel):
    """Response model for HVAC controller operations."""
    temperature: float = Field(..., description="Target temperature in Fahrenheit")
    mode: HVACMode = Field(..., description="HVAC mode")
    status: str = Field(default="success", description="Operation status")
    message: str = Field(default="", description="Additional status message")

# Register HVAC controller tool for simulation
@tool_simulator.tool(
    share_state_id="room_environment",
    initial_state_description="Room environment: temperature 68°F, humidity 45%, HVAC off",
    output_schema=HVACControllerResponse
)
def hvac_controller(temperature: float, mode: str) -> dict[str, Any]:
    """Control home heating/cooling system that affects room temperature and humidity."""
    pass

# Define a task function
def user_task_function(case: Case) -> dict:
    # Inspect initial shared state "room_environment"
    initial_state = tool_simulator.get_state("room_environment")
    print(f"[Room state (before agent invocation)]:")
    print(f"  Initial state: {initial_state.get('initial_state')}")
    print(f"  Previous calls: {initial_state.get('previous_calls', [])}")

    # Create agent with simulated tool
    hvac_tool = tool_simulator.get_tool("hvac_controller")
    agent = Agent(
        trace_attributes={"gen_ai.conversation.id": case.session_id, "session.id": case.session_id},
        system_prompt="You are an HVAC control assistant. Your job is to control the HVAC system using the hvac_controller tool based on information from room temperature/humidity sensors and weather conditions. Always check current room conditions first, consider outdoor weather, then make appropriate HVAC adjustments to meet the user's request.",
        tools=[hvac_tool],
        callback_handler=None,
    )

    # Showcase how user-agent interaction changes room environment state
    agent_response = agent(case.input)
    print(f"[User]: {case.input}")
    print(f"[Agent]: {agent_response}")

    # Inspect final shared state "room_environment" after agent interaction
    final_state = tool_simulator.get_state("room_environment")
    print(f"[Room state (after agent invocation)]:")
    print(f"  Initial state: {final_state.get('initial_state')}")
    print(f"  Previous calls: {final_state.get('previous_calls', [])}")

    finished_spans = memory_exporter.get_finished_spans()
    mapper = StrandsInMemorySessionMapper()
    session = mapper.map_to_session(finished_spans, session_id=case.session_id)

    return {"output": str(agent_response), "trajectory": session}

# Create test cases
test_cases = [
    Case(
        name="temperature_control",
        input="Turn on the heat to 72 degree",
        metadata={"category": "hvac"},
    ),
]

# Create evaluators
evaluators = [GoalSuccessRateEvaluator()]

# Create an experiment
experiment = Experiment[str, str](cases=test_cases, evaluators=evaluators)

# Run evaluations
async def main():
    report = await experiment.run_evaluations_async(user_task_function)
    report.run_display()


if __name__ == "__main__":
    asyncio.run(main())
