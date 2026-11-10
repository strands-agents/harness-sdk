"""Human-in-the-loop intervention for Strands agents.

Pauses agent execution before tool calls to request human approval.
Defaults to interrupt/resume mode for stateless deployments.
Pass ``ask="stdio"`` for CLI prompting or a custom ``ask`` callable for other UIs.

Example:
    ```python
    from strands import Agent
    from strands.vended_interventions.hitl import HumanInTheLoop

    agent = Agent(
        tools=[delete_tool, read_tool],
        interventions=[HumanInTheLoop(allowed_tools=["read_tool"])],
    )

    # Default: agent pauses with stop_reason 'interrupt', caller resumes with response
    result = agent("Delete the file")
    ```
"""

from .classifier import HumanInTheLoopClassifier, LLMClassifierConfig
from .hitl import HumanInTheLoop

__all__ = ["HumanInTheLoop", "HumanInTheLoopClassifier", "LLMClassifierConfig"]
