"""Response Relevance Evaluator Example.

Evaluates whether agent responses are relevant to the user's question.
"""

import asyncio

from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.evaluators import ResponseRelevanceEvaluator
from strands_evals.mappers import StrandsInMemorySessionMapper
from strands_evals.telemetry import StrandsEvalsTelemetry

telemetry = StrandsEvalsTelemetry().setup_in_memory_exporter()


def task_function(case: Case) -> dict:
    agent = Agent(
        trace_attributes={"session.id": case.session_id},
        callback_handler=None,
    )
    response = agent(case.input)
    spans = telemetry.in_memory_exporter.get_finished_spans()
    mapper = StrandsInMemorySessionMapper()
    session = mapper.map_to_session(spans, session_id=case.session_id)
    return {"output": str(response), "trajectory": session}


cases = [
    Case(name="password-reset", input="How do I reset my password?"),
    Case(name="refund-policy", input="What is your refund policy?"),
]

experiment = Experiment(cases=cases, evaluators=[ResponseRelevanceEvaluator()])


async def main():
    report = await experiment.run_evaluations_async(task_function)
    report.run_display()


if __name__ == "__main__":
    asyncio.run(main())
