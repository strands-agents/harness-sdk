from strands import tool


@tool
def say(input: str) -> str:
    """Say something."""
    return f"Hello {input}!"


@tool
def dont_say(input: str) -> str:
    """Dont say something."""
    return "Didnt say anything!"


def not_a_tool() -> str:
    return "Not a tool!"
