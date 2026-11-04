An AI-powered control system for Boston Dynamics Spot robots using the Strands framework. Works with any LLM supported by Strands (Claude, GPT-4, Llama, etc.).

## Overview

This project enables natural language control of Spot robots through an AI agent. Simply tell the robot what to do in plain English, and the LLM interprets your intent and executes the appropriate robot commands.

**Example commands:**

-   “Connect to the robot and stand up”
-   “Move forward for 2 seconds, then turn left”
-   “Take a picture with the front camera”
-   “Dock with the charging station”
-   “Check battery status”

## How It Works

1.  You speak to the agent in natural language
2.  Your configured LLM interprets your request
3.  The agent calls the appropriate robot control tools
4.  The Boston Dynamics SDK sends commands to the physical robot

## Requirements

-   Python 3.10+
-   Boston Dynamics Spot robot with SDK access
-   LLM provider access (AWS Bedrock, OpenAI, Anthropic API, or local models)

## Installation

```bash
pip install -r requirements.txt
```

## Configuration

1.  Copy the example environment file:

```bash
cp example.env .env
```

2.  Edit `.env` with your settings:

```bash
# LLM Model (see Strands docs for supported models)
MODEL=global.anthropic.claude-sonnet-4-5-20250929-v1:0  # AWS Bedrock
# MODEL=gpt-4                                     # OpenAI
# MODEL=claude-4-5-sonnet-20250929                  # Anthropic API

# Robot connection
ROBOT_HOSTNAME="192.168.80.3"
ROBOT_USERNAME="admin"
ROBOT_PASSWORD="your-password"

# For AWS Bedrock
AWS_REGION=us-east-1

# For OpenAI
# OPENAI_API_KEY=your-key

# For Anthropic API
# ANTHROPIC_API_KEY=your-key
```

3.  Configure credentials for your chosen LLM provider.

## Usage

Run the interactive agent:

```bash
python agent.py
```

The agent provides an interactive prompt where you can issue natural language commands.

## Available Robot Commands

| Category | Commands |
| --- | --- |
| Connection | `connect_to_robot`, `robot_force_take_lease` |
| Movement | `robot_stand`, `robot_sit`, `robot_stop` |
| Navigation | `robot_move_forward`, `robot_move_backward`, `robot_strafe_left`, `robot_strafe_right`, `robot_turn_left`, `robot_turn_right` |
| Docking | `robot_dock`, `robot_undock`, `robot_get_dock_status` |
| Status | `robot_get_status`, `robot_toggle_power` |
| Camera | `robot_take_image` |
| Recovery | `robot_self_right`, `robot_battery_change_pose` |

## Architecture

-   `agent.py` - Main agent interface using Strands framework
-   `spot_mcp_server.py` - Robot control tools exposed as Strands tools

## Safety

The system includes built-in safety limits:

-   Maximum movement duration: 10 seconds
-   Maximum movement speed: 1.5 m/s
-   Maximum angular speed: 2.0 rad/s

Always maintain visual contact with the robot and ensure adequate clearance during operation.

## Acknowledgments

-   [Strands Agents](https://github.com/strands-agents) - Agent framework
-   [Boston Dynamics SDK](https://github.com/boston-dynamics/spot-sdk) - Robot control

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/08-edge/strands-spot-agent)
