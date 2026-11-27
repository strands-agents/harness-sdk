"""LangGraph migration guide code examples (Python)."""

from strands import Agent, tool
from strands.multiagent import GraphBuilder
from strands.session import FileSessionManager


# --8<-- [start:graph_migrated]
@tool
def fetch_case_record(case_id: str) -> str:
    """Fetch the filed record for a case.

    Args:
        case_id: Identifier of the case to fetch
    """
    return f"...filed record for {case_id}..."


@tool
def search_precedent(question: str) -> str:
    """Search prior decisions for relevant precedent.

    Args:
        question: What to look for in prior decisions
    """
    return "...matching prior decisions..."


# Entrypoint: same signature as the LangGraph version
def run_case(case_id: str, prompt: str):
    researcher = Agent(
        name="research",
        system_prompt="You gather the facts of the case.",
        tools=[fetch_case_record],
    )
    analyst = Agent(
        name="analysis",
        system_prompt="You weigh the options.",
        tools=[search_precedent],
    )
    reviewer = Agent(name="review", system_prompt="You recommend a decision.")

    builder = GraphBuilder()
    builder.add_node(researcher, "research")
    builder.add_node(analyst, "analysis")
    builder.add_node(reviewer, "review")
    builder.add_edge("research", "analysis")
    builder.add_edge("analysis", "review")
    builder.set_entry_point("research")
    builder.set_max_node_executions(10)

    # case_id is the session id: an interrupted graph resumes from it on the next call
    builder.set_session_manager(
        FileSessionManager(session_id=case_id, storage_dir="./cases/")
    )
    # The task text is what the model sees, so the case id is prefixed onto it.
    return builder.build()(f"Case {case_id}: {prompt}")


result = run_case("case-4127", "Assess the dispute and recommend a decision.")
print(f"Status: {result.status}")
print(f"Order: {[node.node_id for node in result.execution_order]}")
# --8<-- [end:graph_migrated]
