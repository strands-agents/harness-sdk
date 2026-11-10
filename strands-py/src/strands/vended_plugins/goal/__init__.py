"""Goal plugin for Strands Agents — iterative refinement against a validator.

Example:
    ```python
    from strands import Agent
    from strands.vended_plugins.goal import GoalLoop

    concise = GoalLoop(
        goal="At most 3 sentences, accessible to a 10-year-old.",
        max_attempts=3,
    )
    agent = Agent(plugins=[concise])
    agent("Explain how rainbows form.")
    ```
"""

from .judge import JUDGE_SYSTEM_PROMPT, JudgeOutcome, build_judge_prompt
from .plugin import (
    GoalAttempt,
    GoalLoop,
    GoalResult,
    GoalStopReason,
    JudgeConfig,
    ValidationOutcome,
    Validator,
)

__all__ = [
    "GoalLoop",
    "GoalAttempt",
    "GoalResult",
    "GoalStopReason",
    "JudgeConfig",
    "ValidationOutcome",
    "Validator",
    "JUDGE_SYSTEM_PROMPT",
    "JudgeOutcome",
    "build_judge_prompt",
]
