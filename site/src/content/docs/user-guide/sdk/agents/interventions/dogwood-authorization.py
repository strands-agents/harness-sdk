from strands import Agent, tool
from strands.vended_interventions.dogwood import DogwoodAuthorization


@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"


@tool
def delete_record(record_id: str) -> str:
    """Delete a record by ID."""
    return f"Deleted {record_id}"


def basic_example():
    # --8<-- [start:basic]
    from strands import Agent, tool
    from strands.vended_interventions.dogwood import (
        DogwoodAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    @tool
    def delete_record(record_id: str) -> str:
        """Delete a record by ID."""
        return f"Deleted {record_id}"

    dogwood = DogwoodAuthorization(
        policies=(
            'permit(principal, action == Action::"search",'
            " resource);"
        ),
        tools=[search, delete_record],
    )

    agent = Agent(
        tools=[search, delete_record],
        interventions=[dogwood],
    )

    agent("Search for quarterly reports, then delete record 42")
    # search runs; delete_record is denied, no permit matches it
    # --8<-- [end:basic]


def temporal_example():
    # --8<-- [start:temporal]
    from strands import Agent, tool
    from strands.tools.executors import SequentialToolExecutor
    from strands.vended_interventions.dogwood import (
        DogwoodAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    @tool
    def delete_record(record_id: str) -> str:
        """Delete a record by ID."""
        return f"Deleted {record_id}"

    dogwood = DogwoodAuthorization(
        policies="""
          permit(principal, action == Action::"search", resource);

          permit(
            principal,
            action == Action::"delete_record",
            resource
          )
          when temporal {
            formerly within 1h Action::"search"::response{}
          };
        """,
        tools=[search, delete_record],
    )

    agent = Agent(
        tools=[search, delete_record],
        interventions=[dogwood],
        # The default concurrent executor decides every call in a
        # turn before recording any result, so the rule above
        # would not see the search when the model emits both
        # calls at once.
        tool_executor=SequentialToolExecutor(),
    )

    # Denied: nothing has been searched yet in this session
    agent("Delete record 42")

    # Permitted: the search completed less than an hour ago
    agent("Find record 42, then delete it")
    # --8<-- [end:temporal]


def identity_example():
    # --8<-- [start:identity]
    from strands import Agent, tool
    from strands.vended_interventions.dogwood import (
        DogwoodAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    @tool
    def delete_record(record_id: str) -> str:
        """Delete a record by ID."""
        return f"Deleted {record_id}"

    dogwood = DogwoodAuthorization(
        policies="""
          permit(principal == User::"alice", action, resource);

          permit(
            principal == User::"bob",
            action == Action::"search",
            resource
          );
        """,
        tools=[search, delete_record],
        principal_resolver=lambda state: (
            {"type": "User", "id": str(state["user_id"])}
            if state.get("user_id")
            else None
        ),
    )

    agent = Agent(
        tools=[search, delete_record],
        interventions=[dogwood],
    )

    agent(
        "Delete record 42",
        invocation_state={"user_id": "alice"},
    )

    # Denied: bob may only search
    agent(
        "Delete record 42",
        invocation_state={"user_id": "bob"},
    )
    # --8<-- [end:identity]


def file_policy_example():
    # --8<-- [start:file_policy]
    from strands.vended_interventions.dogwood import (
        DogwoodAuthorization,
    )

    dogwood = DogwoodAuthorization(
        policies="./policies/agent.dw",
        action_schema="./policies/agent.cedarschema",
    )
    # --8<-- [end:file_policy]


def session_scope_example():
    # --8<-- [start:session_scope]
    from strands import Agent, tool
    from strands.vended_interventions.dogwood import (
        DogwoodAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    # One agent per session: reset() clears every principal
    dogwood = DogwoodAuthorization(
        policies=(
            'permit(principal, action == Action::"search",'
            " resource);"
        ),
        tools=[search],
        principal={"type": "User", "id": "alice"},
    )

    agent = Agent(tools=[search], interventions=[dogwood])

    agent("Search for quarterly reports")

    # The session is over: forget what the agent did, keep the
    # policy set
    dogwood.reset()
    # --8<-- [end:session_scope]
