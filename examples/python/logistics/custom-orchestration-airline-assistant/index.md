This repository contains custom orchestration code using the airline domain of taubench dataset.

## Agent Orchestration Patterns

Multi-agent AI systems are transforming complex task automation, from customer support to travel planning. As these systems grow sophisticated, they require multiple specialized agents working with diverse tools. However, this complexity brings a critical challenge: **how do we control the flow of information between these components?**

Traditional ReAct-based systems use a single agent for all reasoning and tool decisions. While effective for straightforward tasks, multi-agent scenarios with specialized expertise demand something more sophisticated: **orchestration**.

Agent orchestration designs explicit pathways for information flow in multi-agent systems. It determines which agent processes what information, when they process it, and how their outputs feed into the next step. This structured approach transforms chaotic agent interactions into predictable, debuggable workflows.

**Strands Agents** is an open-source SDK providing building blocks for orchestrated AI systems. It offers flexible agent abstractions, seamless tool integration, and built-in observability. Most importantly, it includes orchestration components like GraphBuilder that connect agents into directed workflows, making reasoning explicit and information flow intentional.

This repository explores **four orchestration patterns** using the same airline tools but structuring reasoning differently:

-   **ReAct**: Single-agent reasoning with direct tool execution
-   **REWOO**: Three-agent system (Planner → Worker → Solver) separating planning from execution
-   **REWOO-ReAct Hybrid**: Two-agent system combining REWOO planning with ReAct execution flexibility
-   **Reflexion**: Iterative improvement cycle with draft generation and quality-focused revision

By implementing these patterns, you’ll learn how Strands enables developers to control information flow between orchestration agents, making systems more transparent, reliable, and easier to monitor in real-world use cases.

This project integrates taubench into a custom orchestration solution. Taubench is a benchmarking dataset that allows for standardized performance testing and analysis.

## Graph Components

Strands orchestration patterns use a **graph execution model** - think of it as a flowchart where each node is a specialized agent and edges define how information flows between them. Unlike ReAct’s hidden decision-making, graphs expose every step, making reasoning visible and debuggable.

### Core Components

Strands provides four fundamental components for any orchestration pattern:

1.  **Nodes**: Agents that encapsulate specific logic or expertise
2.  **Edges**: Connections that define execution order and data flow
3.  **AgentResult**: Standardized output format from each agent
4.  **GraphResult**: Complete execution trace with timing, outputs, and paths taken

### Execution Flow

The system follows a clear asynchronous execution pattern:

1.  **User Prompt** → Triggers asynchronous stream process
2.  **Tool Requests** → Made as needed with results returned
3.  **Message Building** → System builds messages from tool results
4.  **Event Loop Metrics** → Performance tracking created
5.  **Agent Processing** → Results processed through agent logic
6.  **Result Forwarding** → Agent results sent to downstream agents
7.  **Graph Accumulation** → Complete execution trace maintained

![Strands Execution Flow](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/logistics/custom-orchestration-airline-assistant/images/execution_flow.png)

The system follows a clear asynchronous execution pattern with full observability:

*Execution Flow: User Prompt → Agent Processing → Tool Execution → Result Forwarding → Graph Trace*

### GraphBuilder API

The GraphBuilder API lets you wire these components together with clear separation between user interaction, agent logic, tool usage, and result processing:

```python
builder = GraphBuilder()
builder.add_node(planner_agent, "planner")
builder.add_node(solver_agent, "solver")
builder.add_edge("planner", "solver")
builder.set_entry_point("planner")
```

## Getting Started

### Project Structure

```plaintext
15-custom-orchestration-airline-assistant/
├
├── data/
│   ├── tau-bench/
│   │   └── tau_bench/envs/airline/
│   │          ├── tasks_singleturn.json    # Test questions dataset
│   │          ├── data/                    # Flight/user/reservation data
│   │          └── tools/                   # 14 airline domain tools
│   └── ma-bench/
│         └── mabench/environments/airline/
│              └── tools/           # Strands-compatible tools
│── src/
│   ├── reAct_singleTurn.ipynb      # ReAct pattern
│   ├── reWoo_singleTurn.ipynb      # REWOO pattern
│   ├── reWoo-reAct_singleTurn.ipynb # Hybrid pattern
│   ├── reflexion-singleTurn.ipynb  # Reflexion pattern
│   ├── requirements.txt
|
│── helpers/
│   ├── rewoo_helper_funcs.py
│   ├── reWoo_react_helper_funcs.py s
│   ├── bedrock_helper.py
|
└── README.md
```

### Dependencies

-   Git
-   Python 3.8 or higher
-   pip (Python package installer)

## Dataset

In this tutorial, we use the **τ-Bench airline domain dataset** ([https://github.com/sierra-research/tau-bench](https://github.com/sierra-research/tau-bench)), which features:

-   **300+ flight entries** - Comprehensive flight database with routes, schedules, and pricing
-   **500 synthetic user profiles** - Diverse customer personas with booking histories and preferences
-   **2,000+ pre-generated bookings** - Realistic reservation data for testing scenarios
-   **Detailed airline policies** - Complete business rules for upgrades, changes, and cancellations
-   **Simulated APIs** - Full reservation operation endpoints (book, cancel, modify, search)
-   **50 structured real-world scenarios** - Complex customer service situations requiring multi-step reasoning

This comprehensive benchmark provides a controlled yet realistic testbed for assessing how agents interpret policies, execute appropriate API calls, and maintain consistency across complex airline operations including upgrades, itinerary changes, and cancellations.

**Note**: While the original dataset presents each task as a multi-turn conversation, we’ve simplified them into single-turn queries for this tutorial to better showcase the orchestration patterns without conversational complexity.

## How to Run

Each notebook is **standalone and self-contained** - you can open any pattern and run it independently to explore different orchestration approaches.

1.  **Start Jupyter**: Launch Jupyter notebook in the project directory
    
    ```bash
    jupyter notebook
    ```
    
2.  **Select Any Pattern**: Choose any orchestration pattern notebook:
    
    -   `reAct_singleTurn.ipynb` - Single-agent ReAct pattern
    -   `reWoo_singleTurn.ipynb` - Three-agent REWOO pattern
    -   `reWoo-reAct_singleTurn.ipynb` - Two-agent hybrid pattern
    -   `reflexion_singleTurn.ipynb` - Iterative improvement pattern
3.  **Run Cell-by-Cell**: Execute cells sequentially to understand each component:
    
    -   **Setup cells**: Install dependencies and configure Strands framework
    -   **Tool integration**: Import airline domain tools (booking, search, updates)
    -   **Agent implementation**: See how each pattern structures reasoning differently
    -   **Graph construction**: Watch how agents connect in multiagent workflows
    -   **Testing execution**: Run with real airline customer service scenarios
4.  **Customize Test Cases**: Modify the question ID in the final cell to test different scenarios:
    
    ```python
    # Select different questions (0-based index from TauBench dataset)
    question_id = 43  # Try values 0-49 for different airline scenarios
    task = tasks[question_id]
    user_query = task["question"]
    print(user_query)
    ```
    

## Usage

Each notebook provides **comprehensive documentation** explaining the reasoning behind every code cell, making it easy to understand how different orchestration patterns handle the same airline tools and scenarios. This enables direct comparison of approaches for complex multi-step flight booking tasks while learning Strands orchestration concepts step-by-step.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/04-industry-use-cases/logistics/custom-orchestration-airline-assistant)
