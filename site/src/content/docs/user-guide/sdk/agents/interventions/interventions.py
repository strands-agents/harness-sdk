from strands import Agent, tool
from strands.interventions import Confirm, Deny, Guide, InterventionHandler, Proceed, Transform
from strands.hooks.events import (
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
)


# Mock tools for examples
@tool
def search(query: str) -> str:
    """Search for information."""
    return "search results"


@tool
def send_email(to: str, body: str, subject: str = "") -> str:
    """Send an email."""
    return "email sent"


@tool
def delete_file(path: str) -> str:
    """Delete a file."""
    return "deleted"


# =====================
# Basic Usage
# =====================


def basic_usage_example():
    # --8<-- [start:basic_usage]
    from strands import Agent
    from strands.interventions import Deny, InterventionHandler, Proceed

    class ToolGuard(InterventionHandler):
        name = "tool-guard"

        def __init__(self, blocked_tools: list[str]):
            self.blocked_tools = blocked_tools

        def before_tool_call(self, event: BeforeToolCallEvent):
            if event.tool_use["name"] in self.blocked_tools:
                name = event.tool_use["name"]
                return Deny(
                    reason=f"Tool '{name}' is not allowed"
                )
            return Proceed()

    agent = Agent(
        tools=[search, delete_file],
        interventions=[ToolGuard(blocked_tools=["delete_file"])],
    )

    # The agent can search freely, but any attempt to call delete_file
    # is blocked before execution: the model sees the denial reason
    # and adjusts its approach
    agent("Clean up the temp directory")
    # --8<-- [end:basic_usage]


# =====================
# Action Types
# =====================


def action_types_example():
    # --8<-- [start:action_types]
    from strands.interventions import (
        Confirm, Deny, Guide, InterventionHandler,
        Proceed, Transform,
    )

    # Deny: block tool calls that access production resources
    class EnvironmentGuard(InterventionHandler):
        name = "environment-guard"

        def before_tool_call(self, event: BeforeToolCallEvent):
            tool_input = event.tool_use.get("input", {})
            if "prod" in tool_input.get("database", ""):
                return Deny(reason="Production database access is not allowed")
            return Proceed()

    # Guide: steer the model when it tries to send emails without a subject
    class EmailValidator(InterventionHandler):
        name = "email-validator"

        def before_tool_call(self, event: BeforeToolCallEvent):
            if event.tool_use["name"] == "send_email":
                tool_input = event.tool_use.get("input", {})
                if not tool_input.get("subject"):
                    return Guide(feedback="All emails must include a subject line.")
            return Proceed()

    # Confirm: require human approval before deleting files
    class DeleteApproval(InterventionHandler):
        name = "delete-approval"

        def before_tool_call(self, event: BeforeToolCallEvent):
            if event.tool_use["name"] == "delete_file":
                tool_input = event.tool_use.get("input", {})
                return Confirm(prompt=f"Approve deleting \"{tool_input.get('path')}\"?")
            return Proceed()

    # Transform: redact PII from outgoing email bodies
    class PiiRedactor(InterventionHandler):
        name = "pii-redactor"

        def before_tool_call(self, event: BeforeToolCallEvent):
            if event.tool_use["name"] == "send_email":
                import re

                def redact(e: BeforeToolCallEvent):
                    tool_input = e.tool_use.get("input", {})
                    body = tool_input.get("body", "")
                    ssn_pattern = r"\b\d{3}-\d{2}-\d{4}\b"
                    tool_input["body"] = re.sub(
                        ssn_pattern, "[REDACTED]", body
                    )

                return Transform(apply=redact)
            return Proceed()

    # --8<-- [end:action_types]


# =====================
# Short-Circuiting
# =====================


def short_circuiting_example():
    # --8<-- [start:short_circuiting]
    from strands import Agent
    from strands.interventions import Deny, Guide, InterventionHandler, Proceed

    class RateLimiter(InterventionHandler):
        name = "rate-limiter"

        def __init__(self):
            self.call_count = 0

        def before_tool_call(self, event: BeforeToolCallEvent):
            self.call_count += 1
            if self.call_count > 10:
                # Deny short-circuits: handlers registered after this one are skipped
                return Deny(reason="Rate limit exceeded")
            return Proceed()

    class ToneSteering(InterventionHandler):
        name = "tone-steering"

        def after_model_call(self, event: AfterModelCallEvent):
            # This handler never runs for denied tool calls
            return Guide(feedback="Use a more professional tone.")

    # Handlers evaluate in registration order
    agent = Agent(
        tools=[search],
        interventions=[
            RateLimiter(),    # Evaluates first
            ToneSteering(),   # Skipped if RateLimiter denies
        ],
    )
    # --8<-- [end:short_circuiting]


# =====================
# Error Handling
# =====================


def error_handling_example():
    # --8<-- [start:error_handling]
    from strands.interventions import Deny, InterventionHandler, OnError, Proceed

    # 'proceed': if this handler throws, continue as if Proceed() was returned
    class BestEffortLogger(InterventionHandler):
        name = "best-effort-logger"

        @property
        def on_error(self) -> OnError:
            return "proceed"

        def before_tool_call(self, event: BeforeToolCallEvent):
            # If the logging service is unreachable, the agent continues normally
            print(f"Tool called: {event.tool_use['name']}")
            return Proceed()

    # 'deny': if this handler throws, treat it as a Deny (fail-closed)
    class StrictAuth(InterventionHandler):
        name = "strict-auth"

        @property
        def on_error(self) -> OnError:
            return "deny"

        def before_tool_call(self, event: BeforeToolCallEvent):
            # If the auth service is down (throws), the operation is denied
            if not self._check_permission(event.tool_use["name"]):
                return Deny(reason="Unauthorized")
            return Proceed()

        def _check_permission(self, tool_name: str) -> bool:
            # ... call external auth service
            return True

    # 'throw' (default): errors propagate and fail the invocation
    class CriticalValidator(InterventionHandler):
        name = "critical-validator"
        # on_error defaults to 'throw'

        def before_tool_call(self, event: BeforeToolCallEvent):
            # If this throws, the entire invocation fails
            return Proceed()

    # --8<-- [end:error_handling]


# =====================
# Confirm Action
# =====================


def confirm_example():
    # --8<-- [start:confirm]
    from strands.interventions import Confirm, InterventionHandler, Proceed

    class SensitiveToolApproval(InterventionHandler):
        name = "sensitive-tool-approval"

        def before_tool_call(self, event: BeforeToolCallEvent):
            if event.tool_use["name"] in ("delete_file", "send_email"):
                return Confirm(
                    prompt=f"Allow {event.tool_use['name']}?"
                )
            return Proceed()

    # Preemptive approval: agent doesn't pause
    class AutoApprove(InterventionHandler):
        name = "auto-approve"

        def before_tool_call(self, event: BeforeToolCallEvent):
            if event.tool_use["name"] == "search":
                return Confirm(
                    prompt="Allow search?",
                    response="yes",
                )
            return Proceed()

    # --8<-- [end:confirm]
