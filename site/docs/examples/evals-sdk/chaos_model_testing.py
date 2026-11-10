import asyncio
import logging

from strands import Agent

from strands_evals import Case
from strands_evals.chaos import (
    ChaosCase,
    ChaosExperiment,
    ChaosPlugin,
    Confabulation,
    EmptyResponse,
    FullRefusal,
    MalformedJson,
    SuccessFraming,
)
from strands_evals.eval_task_handler import TracedHandler, eval_task
from strands_evals.evaluators import GoalSuccessRateEvaluator

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# 1. Create the ChaosPlugin
chaos_plugin = ChaosPlugin()

# 2. Define named effect maps.
#    model_effects is keyed by "*" (applies to all models; per-model targeting is a
#    future extension). At most one pre-model-call effect per case, since a
#    pre-model-call effect cancels the model call and only one can take effect.
effect_maps = {
    # Pre-model-call: the model call is cancelled; the refusal text becomes the turn.
    "full_refusal": {
        "model_effects": {"*": [FullRefusal()]},
    },
    # Pre-model-call: the model call is cancelled with a blank turn,
    # simulating "the model returned nothing".
    "empty_response": {
        "model_effects": {"*": [EmptyResponse()]},
    },
    # Post-model-call: the real response is corrupted after the model runs.
    "malformed_json": {
        "model_effects": {"*": [MalformedJson()]},
    },
    # Post-model-call, composed: fabricated citations wrapped in confident framing
    # (SuccessFraming is always applied last).
    "confabulation_framed": {
        "model_effects": {"*": [Confabulation(), SuccessFraming()]},
    },
}


# 3. Define the task function
@eval_task(TracedHandler())
def travel_agent_task(case: ChaosCase):
    """Run the travel assistant with a single user query."""
    logger.info(f"\n{'─'*60}")
    logger.info(f" Case: {case.name}")
    logger.info(f" User: {case.input}")
    logger.info(f"{'─'*60}")
    return Agent(
        system_prompt=(
            "You are a travel planning assistant. Answer the user's question "
            "directly and honestly. Today's date is May 18, 2025."
        ),
        plugins=[chaos_plugin],
        callback_handler=None,
        trace_attributes={"gen_ai.conversation.id": case.session_id, "session.id": case.session_id},
    )


# 4. Define test cases and expand with effect maps
test_cases = [
    Case(
        name="trip_planning",
        input="What is the best way to travel from SFO to JFK on May 20? Summarize your recommendation.",
 expected_assertion="The agent should provide a travel recommendation for getting from SFO to JFK and summarize it.",
    ),
]

# Expand: 1 case x (4 effect maps + 1 baseline) = 5 ChaosCase objects
chaos_cases = ChaosCase.expand(test_cases, effect_maps, include_no_effect_baseline=True)

# 5. Create and run the ChaosExperiment
experiment = ChaosExperiment(
    cases=chaos_cases,
    evaluators=[GoalSuccessRateEvaluator()],
)


async def main():
    report = await experiment.run_evaluations_async(task=travel_agent_task, max_workers=1)
    report.run_display()


asyncio.run(main())
