from strands import Agent, tool
from strands.vended_interventions.hitl import (
    HumanInTheLoop,
    LLMClassifierConfig,
)


@tool
def delete_files(paths: list[str]) -> str:
    """Delete files at the given paths."""
    return f"Deleted {len(paths)} files"


@tool
def read_file(path: str) -> str:
    """Read a file."""
    return f"Contents of {path}"


async def ask_user_via_slack(prompt: str) -> str:
    return "yes"


# =====================
# Basic (Interrupt/Resume Mode)
# =====================


def basic_interrupt_example():
    # --8<-- [start:basic_interrupt]
    agent = Agent(
        tools=[delete_files],
        interventions=[HumanInTheLoop()],
    )

    # Agent pauses with stop_reason 'interrupt' when a tool needs approval
    result = agent("Delete the temp files")

    if result.stop_reason == "interrupt":
        # Present the interrupt to the user (web UI, Slack, etc.)
        print(result.interrupts[0].reason)

        # Resume with the human's response
        result = agent(
            [
                {
                    "interruptResponse": {
                        "interruptId": result.interrupts[0].id,
                        "response": "yes",  # 'y', 'yes', or True -> approved
                    }
                }
            ]
        )
    # --8<-- [end:basic_interrupt]


# =====================
# Stdio Mode
# =====================


def stdio_mode_example():
    # --8<-- [start:stdio_mode]
    agent = Agent(
        tools=[delete_files],
        interventions=[HumanInTheLoop(ask="stdio")],
    )

    agent("Delete the temp files")
    # Terminal prompt:
    # Tool "delete_files" requires human approval. Input: {...} (y/n):
    # --8<-- [end:stdio_mode]


# =====================
# Custom Ask Callback
# =====================


def custom_ask_example():
    # --8<-- [start:custom_ask]
    async def ask(prompt: str) -> str:
        # Your UI: Slack DM, web modal, push notification, etc.
        return await ask_user_via_slack(prompt)

    agent = Agent(
        tools=[delete_files],
        interventions=[HumanInTheLoop(ask=ask)],
    )

    agent("Delete the temp files")
    # --8<-- [end:custom_ask]


# =====================
# Allowed Tools
# =====================


def allowed_tools_example():
    # --8<-- [start:allowed_tools]
    agent = Agent(
        tools=[read_file, delete_files],
        interventions=[
            HumanInTheLoop(
                ask="stdio",
                # Pattern syntax:
                #   "read_file"             -> runs without approval
                #   "*"                     -> all tools run freely (disables handler)
                #   ["*", "!delete_files"]  -> all except delete_files
                allowed_tools=["read_file"],
            ),
        ],
    )

    agent("Read config.json then delete /tmp/old-logs")
    # Only delete_files prompts; read_file executes immediately
    # --8<-- [end:allowed_tools]


# =====================
# Trust Mode
# =====================


def trust_mode_example():
    # --8<-- [start:trust_mode]
    agent = Agent(
        tools=[delete_files],
        interventions=[
            HumanInTheLoop(
                ask="stdio",
                enable_trust=True,
            ),
        ],
    )

    agent("Delete all log files in /tmp")
    # First call: user responds 't' -> approved AND remembered
    # Subsequent calls: no prompt needed for the session
    # --8<-- [end:trust_mode]


# =====================
# Custom Evaluate
# =====================


def custom_evaluate_example():
    # --8<-- [start:custom_evaluate]
    agent = Agent(
        tools=[delete_files],
        interventions=[
            HumanInTheLoop(
                ask="stdio",
                # Only approve if the user types "confirm"
                evaluate=lambda response: isinstance(response, str) and response.lower() == "confirm",
            ),
        ],
    )

    agent("Delete the temp files")
    # Prompt: Tool "delete_files" requires human approval. Input: {...}
    # User must type "confirm" to approve (not just "y" or "yes")
    # --8<-- [end:custom_evaluate]


# =====================
# Classifier (LLM Risk Classification)
# =====================


def classifier_example():
    # --8<-- [start:classifier]
    agent = Agent(
        tools=[read_file, delete_files],
        interventions=[
            HumanInTheLoop(
                allowed_tools=["read_file"],
                classifier=True,
            ),
        ],
    )

    agent("Read config.json then delete /tmp/old-logs")
    # read_file: allowed (bypasses classifier)
    # delete_files: classifier evaluates -> risky -> prompts human
    # --8<-- [end:classifier]


def classifier_custom_example():
    # --8<-- [start:classifier_custom]
    # Custom system prompt and model
    agent = Agent(
        tools=[delete_files],
        interventions=[
            HumanInTheLoop(
                classifier=LLMClassifierConfig(
                    system_prompt="Only flag destructive operations.",
                ),
            ),
        ],
    )

    # Or provide your own classification function
    def my_classifier(event, **kwargs):
        from strands.vended_interventions.hitl.classifier import (
            ClassifierResult,
        )

        is_dangerous = event.tool_use["name"].startswith("delete")
        return ClassifierResult(
            requires_human_in_the_loop=is_dangerous,
            reason="destructive tool" if is_dangerous else None,
        )

    agent = Agent(
        tools=[delete_files],
        interventions=[HumanInTheLoop(classifier=my_classifier)],
    )
    # --8<-- [end:classifier_custom]
