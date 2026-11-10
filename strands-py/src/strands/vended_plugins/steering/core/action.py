"""SteeringAction types for steering evaluation results.

Defines structured outcomes from steering handlers that determine how agent actions
should be handled. SteeringActions enable modular prompting by providing just-in-time
feedback rather than front-loading all instructions in monolithic prompts.

Flow:
    SteeringHandler.steer_*() → SteeringAction → Event handling
                    ↓                     ↓              ↓
              Evaluate context      Action type    Execution modified

SteeringAction types:
    Proceed: Allow execution to continue without intervention
    Guide: Provide contextual guidance to redirect the agent
    Interrupt: Pause execution for human input

Extensibility:
    New action types can be added to the union. Always handle the default
    case in pattern matching to maintain backward compatibility.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class Proceed(BaseModel):
    """Allow execution to continue without intervention.

    The action proceeds as planned. The reason provides context
    for logging and debugging purposes.
    """

    type: Literal["proceed"] = "proceed"
    reason: str


class Guide(BaseModel):
    """Provide contextual guidance to redirect the agent.

    The agent receives the reason as contextual feedback to help guide
    its behavior. The specific handling depends on the steering context
    (e.g., tool call vs. model response).
    """

    type: Literal["guide"] = "guide"
    reason: str


class Interrupt(BaseModel):
    """Pause execution for human input via interrupt system.

    Execution is paused and human input is requested through Strands'
    interrupt system. The human can approve or deny the operation, and their
    decision determines whether execution continues or is cancelled.
    """

    type: Literal["interrupt"] = "interrupt"
    reason: str


# Context-specific steering action types
ToolSteeringAction = Annotated[Proceed | Guide | Interrupt, Field(discriminator="type")]
"""Steering actions valid for tool steering (steer_before_tool).

- Proceed: Allow tool execution to continue
- Guide: Cancel tool and provide feedback for alternative approaches
- Interrupt: Pause for human input before tool execution
"""

ModelSteeringAction = Annotated[Proceed | Guide, Field(discriminator="type")]
"""Steering actions valid for model steering (steer_after_model).

- Proceed: Accept model response without modification
- Guide: Discard model response and retry with guidance
"""
