"""Deterministic Evaluators Example.

Fast, code-based evaluation without LLM judges.
"""

import asyncio

from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.evaluators import Contains, Equals, StartsWith, ToolCalled

# --- Output evaluators ---


def get_response(case: Case) -> str:
    agent = Agent(callback_handler=None)
    return str(agent(case.input))


cases = [
    Case(
        name="capital",
        input="What is the capital of France? Reply with just the city name.",
        expected_output="Paris",
    ),
]

experiment = Experiment(
    cases=cases,
    evaluators=[
        Contains(value="Paris", case_sensitive=False),
        Equals(),  # compares against expected_output
    ],
)

# --- Trajectory evaluator ---

from strands_evals.extractors import tools_use_extractor
from strands.vended_tools import sleep


def get_response_with_tools(case: Case) -> dict:
    agent = Agent(tools=[sleep], callback_handler=None)
    response = agent(case.input)
    trajectory = tools_use_extractor.extract_agent_tools_used_from_messages(agent.messages)
    return {"output": str(response), "trajectory": trajectory}


tool_cases = [
    Case(name="pause", input="Pause for 1 second using the sleep tool", expected_trajectory=["sleep"]),
]

tool_experiment = Experiment(
    cases=tool_cases,
    evaluators=[ToolCalled(tool_name="sleep")],
)


async def main():
    report = await experiment.run_evaluations_async(get_response)
    report.run_display()
    tool_report = await tool_experiment.run_evaluations_async(get_response_with_tools)
    tool_report.run_display()


if __name__ == "__main__":
    asyncio.run(main())
