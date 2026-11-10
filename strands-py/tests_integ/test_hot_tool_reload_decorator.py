"""
Integration test for hot tool reloading functionality with the @tool decorator.

This test verifies that the Strands Agent can automatically detect and load
new tools created with the @tool decorator when they are added to a tools directory.
"""

import logging
import os
import time
from pathlib import Path

from strands import Agent

logging.getLogger("strands").setLevel(logging.DEBUG)
logging.basicConfig(format="%(levelname)s | %(name)s | %(message)s", handlers=[logging.StreamHandler()])


def test_hot_reload_decorator():
    """
    Test that the Agent automatically loads tools created with @tool decorator
    when added to the current working directory's tools folder.
    """
    # Set up the tools directory in current working directory
    tools_dir = Path.cwd() / "tools"
    os.makedirs(tools_dir, exist_ok=True)

    # Tool path that will need cleanup
    test_tool_path = tools_dir / "uppercase.py"

    try:
        # Create an Agent instance without any tools
        agent = Agent(load_tools_from_directory=True)

        # Create a test tool using @tool decorator
        with open(test_tool_path, "w") as f:
            f.write("""
from strands import tool

@tool
def uppercase(text: str) -> str:
    \"\"\"Convert text to uppercase.\"\"\"
    return f"Input: {text}, Output: {text.upper()}"
""")

        # Wait for tool detection
        time.sleep(3)

        # Verify the tool was automatically loaded
        assert "uppercase" in agent.tool_names, "Agent should have detected and loaded the uppercase tool"

        # Test calling the dynamically loaded tool
        result = agent.tool.uppercase(text="hello world")

        # Check that the result is successful
        assert result.get("status") == "success", "Tool call should be successful"

        # Check the content of the response
        content_list = result.get("content", [])
        assert len(content_list) > 0, "Tool response should have content"

        # Check that the expected message is in the content
        text_content = next((item.get("text") for item in content_list if "text" in item), "")
        assert "Input: hello world, Output: HELLO WORLD" in text_content

    finally:
        # Clean up - remove the test file
        if test_tool_path.exists():
            os.remove(test_tool_path)


def test_hot_reload_decorator_update():
    """
    Test that the Agent detects updates to tools created with @tool decorator.
    """
    # Set up the tools directory in current working directory
    tools_dir = Path.cwd() / "tools"
    os.makedirs(tools_dir, exist_ok=True)

    # Tool path that will need cleanup - make sure filename matches function name
    test_tool_path = tools_dir / "greeting.py"

    try:
        # Create an Agent instance
        agent = Agent(load_tools_from_directory=True)

        # Create the initial version of the tool
        with open(test_tool_path, "w") as f:
            f.write("""
from strands import tool

@tool
def greeting(name: str) -> str:
    \"\"\"Generate a simple greeting.\"\"\"
    return f"Hello, {name}!"
""")

        # Wait for tool detection
        time.sleep(3)

        # Verify the tool was loaded
        assert "greeting" in agent.tool_names, "Agent should have detected and loaded the greeting tool"

        # Test calling the tool
        result1 = agent.tool.greeting(name="Strands")
        text_content1 = next((item.get("text") for item in result1.get("content", []) if "text" in item), "")
        assert "Hello, Strands!" in text_content1, "Tool should return simple greeting"

        # Update the tool with new functionality
        with open(test_tool_path, "w") as f:
            f.write("""
from strands import tool
import datetime

@tool
def greeting(name: str, formal: bool = False) -> str:
    \"\"\"Generate a greeting with optional formality.\"\"\"
    current_hour = datetime.datetime.now().hour
    time_of_day = "morning" if current_hour < 12 else "afternoon" if current_hour < 18 else "evening"

    if formal:
        return f"Good {time_of_day}, {name}. It's a pleasure to meet you."
    else:
        return f"Hey {name}! How's your {time_of_day} going?"
""")

        # Wait for hot reload to detect the change
        time.sleep(3)

        # Test calling the updated tool
        result2 = agent.tool.greeting(name="Strands", formal=True)
        text_content2 = next((item.get("text") for item in result2.get("content", []) if "text" in item), "")
        assert "Good" in text_content2 and "Strands" in text_content2 and "pleasure to meet you" in text_content2

        # Test with informal parameter
        result3 = agent.tool.greeting(name="Strands", formal=False)
        text_content3 = next((item.get("text") for item in result3.get("content", []) if "text" in item), "")
        assert "Hey Strands!" in text_content3 and "going" in text_content3

    finally:
        # Clean up - remove the test file
        if test_tool_path.exists():
            os.remove(test_tool_path)
