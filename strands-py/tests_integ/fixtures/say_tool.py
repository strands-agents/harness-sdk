from strands import tool


@tool
def say(input: str) -> str:
    """Say the input"""
    return f"Said: {input}"
