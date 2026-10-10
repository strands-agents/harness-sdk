"""LangGraph migration guide code examples (Python)."""

from strands import Agent
from strands.multiagent import GraphBuilder
from strands.session import FileSessionManager


# --8<-- [start:graph_migrated]
# Entrypoint: same signature as the LangGraph version
def run_case(case_id: str, prompt: str):
    researcher = Agent(name="research", system_prompt="You gather the facts of the case.")
    analyst = Agent(name="analysis", system_prompt="You weigh the options.")
    reviewer = Agent(name="review", system_prompt="You recommend a decision.")

    builder = GraphBuilder()
    builder.add_node(researcher, "research")
    builder.add_node(analyst, "analysis")
    builder.add_node(reviewer, "review")
    builder.add_edge("research", "analysis")
    builder.add_edge("analysis", "review")
    builder.set_entry_point("research")

    # case_id is the session id: the graph restores prior state on the next call
    builder.set_session_manager(
        FileSessionManager(session_id=case_id, storage_dir="./cases/")
    )
    return builder.build()(prompt)


result = run_case("case-4127", "Assess the tenant dispute in the record.")
print(f"Status: {result.status}")
print(f"Order: {[node.node_id for node in result.execution_order]}")
# --8<-- [end:graph_migrated]
