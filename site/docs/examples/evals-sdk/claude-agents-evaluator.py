import asyncio
from typing import Any

from openinference.instrumentation.claude_agent_sdk import ClaudeAgentSDKInstrumentor

from strands_evals import Case, Experiment
from strands_evals.evaluators import GoalSuccessRateEvaluator, HelpfulnessEvaluator
from strands_evals.mappers import detect_otel_mapper, readable_spans_to_dicts
from strands_evals.telemetry import StrandsEvalsTelemetry

# =============================================================================
# 1. Agent Setup
# =============================================================================

telemetry = StrandsEvalsTelemetry().setup_in_memory_exporter()
ClaudeAgentSDKInstrumentor().instrument()

# Import after instrument() so the instrumentor patches the SDK before its symbols are bound.
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query  # noqa: E402

async def run_commit_agent(diff: str) -> str:
    options = ClaudeAgentOptions(
        allowed_tools=["Bash"],
        max_turns=3,
        system_prompt=(
            "Write a conventional commit message for the given diff. "
            "Format: <type>(<scope>): <subject>. "
            "Types: feat, fix, docs, style, refactor, perf, test, chore. "
            "Imperative mood, lowercase, no period. Output only the commit message."
        ),
        env={
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "ANTHROPIC_MODEL": "us.anthropic.claude-sonnet-4-6",
            "AWS_REGION": "us-east-1",
        },
    )
    result = ""
    async for msg in query(
        prompt=f"Generate a commit message for this diff:\n\n{diff}",
        options=options,
    ):
        if isinstance(msg, ResultMessage) and msg.subtype == "success":
            result = msg.result

    return result.strip()


# =============================================================================
# 2. Experiment Setup
# =============================================================================


async def task(case: Case) -> dict[str, Any]:
    telemetry.in_memory_exporter.clear()

    response = await run_commit_agent(case.input)
    telemetry.tracer_provider.force_flush()

    spans = readable_spans_to_dicts(telemetry.in_memory_exporter.get_finished_spans())
    session = detect_otel_mapper(spans).map_to_session(spans, session_id=case.session_id)
    return {"output": response, "trajectory": session}


experiment = Experiment(
    cases=[
        Case(
            name="fix-null-check",
            input=(
                "# src/user.py\n"
                "-    return user['name'].upper()\n"
                "+    if not user or 'name' not in user:\n"
                "+        return 'Anonymous'\n"
                "+    return user['name'].upper()\n"
            ),
            expected_output="fix(user): handle missing user or name field in get_display_name",
        ),
    ],
    evaluators=[HelpfulnessEvaluator(), GoalSuccessRateEvaluator()],
)


async def main():
    report = await experiment.run_evaluations_async(task)

    for case, score, passed, reason in zip(report.cases, report.scores, report.test_passes, report.reasons):
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {case['name']} ({case['evaluator']}): {score:.2f}")
        print(f"  Reason: {reason}\n")


asyncio.run(main())
