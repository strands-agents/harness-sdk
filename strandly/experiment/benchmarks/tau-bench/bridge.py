#!/usr/bin/env python3
"""
tau-bench bridge — stdio JSON-RPC interface between the TS adapter and tau-bench.

Protocol:
  1. Reads init args from stdin (env_name, task_index, user_model, user_provider)
  2. Writes initialize message with user_message, tools, wiki
  3. Loops: reads tool_call requests, calls env.step(), writes results
"""

import json
import sys

from tau_bench.envs import get_env
from tau_bench.types import Action


def write_msg(msg: dict) -> None:
    """Write a JSON-RPC message to stdout."""
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def read_msg() -> dict:
    """Read a JSON-RPC message from stdin."""
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def main() -> None:
    # --- Initialization: read config from stdin ---
    init = read_msg()
    params = init.get("params", {})
    env_name = params.get("env_name", "retail")
    task_index = params.get("task_index", 0)
    user_model = params.get("user_model", "bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")
    user_provider = params.get("user_provider", "bedrock")

    # --- Set up the environment ---
    env = get_env(
        env_name=env_name,
        user_strategy="llm",
        user_model=user_model,
        user_provider=user_provider,
        task_split="test",
    )

    reset_response = env.reset(task_index=task_index)

    # Extract tool schemas (OpenAI function-calling format)
    tools = list(env.tools_info)

    # tau-bench expects a "respond" action for agent→user replies, but it's not
    # included in tools_info — it's handled specially in env.step(). We synthesize
    # the schema so the TS agent knows to call it.
    existing_names = {t.get("function", {}).get("name") for t in tools if "function" in t}
    if "respond" not in existing_names:
        tools.append({
            "type": "function",
            "function": {
                "name": "respond",
                "description": "Send a message to the user. Use this tool to reply to the user's request.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "The message content to send to the user.",
                        }
                    },
                    "required": ["content"],
                },
            },
        })

    # Build wiki/instructions from the environment
    wiki = ""
    if hasattr(env, "wiki") and env.wiki:
        wiki = env.wiki

    # Send initialization response
    write_msg({
        "jsonrpc": "2.0",
        "method": "initialize",
        "params": {
            "user_message": reset_response.observation,
            "tools": tools,
            "wiki": wiki,
        },
    })

    # --- Main loop: handle tool calls ---
    while True:
        request = read_msg()
        method = request.get("method")

        if method == "tool_call":
            call_params = request.get("params", {})
            name = call_params.get("name", "")
            arguments = call_params.get("arguments", {})

            # Execute the action in the environment
            action = Action(name=name, kwargs=arguments)
            response = env.step(action)

            write_msg({
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "result": {
                    "observation": response.observation,
                    "done": response.done,
                    "reward": response.reward,
                },
            })

            if response.done:
                break
        else:
            write_msg({
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -32601, "message": f"Unknown method: {method}"},
            })


if __name__ == "__main__":
    main()
