"""Experimental agent configuration utilities.

This module provides utilities for creating agents from configuration files or dictionaries.

Note: Configuration-based agent setup only works for tools that don't require code-based
instantiation. For tools that need constructor arguments or complex setup, use the
programmatic approach after creating the agent:

    agent = config_to_agent("config.json")
    # Add tools that need code-based instantiation
    agent.tool_registry.process_tools([ToolWithConfigArg(HttpsConnection("localhost"))])
"""

import json
from pathlib import Path
from typing import Any

import jsonschema
from jsonschema import ValidationError

# JSON Schema for agent configuration
AGENT_CONFIG_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Agent Configuration",
    "description": "Configuration schema for creating agents",
    "type": "object",
    "properties": {
        "name": {"description": "Name of the agent", "type": ["string", "null"], "default": None},
        "model": {
            "description": "The model ID to use for this agent. If not specified, uses the default model.",
            "type": ["string", "null"],
            "default": None,
        },
        "prompt": {
            "description": "The system prompt for the agent. Provides high level context to the agent.",
            "type": ["string", "null"],
            "default": None,
        },
        "tools": {
            "description": "List of tools the agent can use. Can be file paths, "
            "Python module names, or @tool annotated functions in files.",
            "type": "array",
            "items": {"type": "string"},
            "default": [],
        },
    },
    "additionalProperties": False,
}

# Pre-compile validator for better performance
_VALIDATOR = jsonschema.Draft7Validator(AGENT_CONFIG_SCHEMA)


def config_to_agent(config: str | dict[str, Any], **kwargs: dict[str, Any]) -> Any:
    """Create an Agent from a configuration file or dictionary.

    This function supports tools that can be loaded declaratively (file paths, module names,
    or @tool annotated functions). For tools requiring code-based instantiation with constructor
    arguments, add them programmatically after creating the agent:

        agent = config_to_agent("config.json")
        agent.process_tools([ToolWithConfigArg(HttpsConnection("localhost"))])

    Args:
        config: Either a file path (with optional file:// prefix) or a configuration dictionary
        **kwargs: Additional keyword arguments to pass to the Agent constructor

    Returns:
        Agent: A configured Agent instance

    Raises:
        FileNotFoundError: If the configuration file doesn't exist
        json.JSONDecodeError: If the configuration file contains invalid JSON
        ValueError: If the configuration is invalid or tools cannot be loaded

    Examples:
        Create agent from file:
        >>> agent = config_to_agent("/path/to/config.json")

        Create agent from file with file:// prefix:
        >>> agent = config_to_agent("file:///path/to/config.json")

        Create agent from dictionary:
        >>> config = {"model": "anthropic.claude-3-5-sonnet-20241022-v2:0", "tools": ["calculator"]}
        >>> agent = config_to_agent(config)
    """
    # Parse configuration
    if isinstance(config, str):
        # Handle file path
        file_path = config

        # Remove file:// prefix if present
        if file_path.startswith("file://"):
            file_path = file_path[7:]

        # Load JSON from file
        config_path = Path(file_path)
        if not config_path.exists():
            raise FileNotFoundError(f"Configuration file not found: {file_path}")

        with open(config_path) as f:
            config_dict = json.load(f)
    elif isinstance(config, dict):
        config_dict = config.copy()
    else:
        raise ValueError("Config must be a file path string or dictionary")

    # Validate configuration against schema
    try:
        _VALIDATOR.validate(config_dict)
    except ValidationError as e:
        # Provide more detailed error message
        error_path = " -> ".join(str(p) for p in e.absolute_path) if e.absolute_path else "root"
        raise ValueError(f"Configuration validation error at {error_path}: {e.message}") from e

    # Prepare Agent constructor arguments
    agent_kwargs = {}

    # Map configuration keys to Agent constructor parameters
    config_mapping = {
        "model": "model",
        "prompt": "system_prompt",
        "tools": "tools",
        "name": "name",
    }

    # Only include non-None values from config
    for config_key, agent_param in config_mapping.items():
        if config_key in config_dict and config_dict[config_key] is not None:
            agent_kwargs[agent_param] = config_dict[config_key]

    # Override with any additional kwargs provided
    agent_kwargs.update(kwargs)

    # Import Agent at runtime to avoid circular imports
    from ..agent import Agent

    # Create and return Agent
    return Agent(**agent_kwargs)
