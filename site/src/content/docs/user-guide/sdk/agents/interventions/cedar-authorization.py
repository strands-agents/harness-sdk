from strands import Agent, tool
from strands.vended_interventions.cedar import CedarAuthorization


@tool
def search(query: str) -> str:
    """Search for information."""
    return f"Results for: {query}"


@tool
def delete_record(record_id: str) -> str:
    """Delete a record by ID."""
    return f"Deleted {record_id}"


@tool
def send_email(to: str, body: str) -> str:
    """Send an email."""
    return f"Sent to {to}"


@tool
def deploy(version: str) -> str:
    """Deploy the service."""
    return f"Deployed {version}"


def basic_example():
    # --8<-- [start:basic_example]
    from strands import Agent, tool
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    @tool
    def delete_record(record_id: str) -> str:
        """Delete a record by ID."""
        return f"Deleted {record_id}"

    cedar = CedarAuthorization(
        policies=(
            'permit(principal, action == Action::"search",'
            " resource);"
        ),
    )

    agent = Agent(
        tools=[search, delete_record],
        interventions=[cedar],
    )

    agent(
        "Search for quarterly reports then delete record 42"
    )
    # search is permitted; delete_record is denied
    # (no matching permit)
    # --8<-- [end:basic_example]


def role_based_example():
    # --8<-- [start:role_based]
    from strands import Agent, tool
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    @tool
    def delete_record(record_id: str) -> str:
        """Delete a record by ID."""
        return f"Deleted {record_id}"

    cedar = CedarAuthorization(
        policies="""
          permit(principal, action, resource)
          when { context.session.role == "admin" };

          permit(
            principal,
            action == Action::"search",
            resource
          )
          when { context.session.role == "analyst" };
        """,
        principal_resolver=lambda state: (
            {"type": "User", "id": state["user_id"]}
            if state.get("user_id")
            else None
        ),
        context_enricher=lambda ctx: {
            "role": ctx["invocation_state"].get(
                "role", "none"
            ),
        },
    )

    agent = Agent(
        tools=[search, delete_record],
        interventions=[cedar],
    )

    # admin can use any tool
    agent(
        "Delete record 42",
        invocation_state={
            "user_id": "alice",
            "role": "admin",
        },
    )

    # analyst can only search
    agent(
        "Delete record 42",
        invocation_state={
            "user_id": "bob",
            "role": "analyst",
        },
    )
    # denied: no permit for delete_record with "analyst"
    # --8<-- [end:role_based]


def rate_limit_example():
    # --8<-- [start:rate_limit]
    from strands import Agent, tool
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
    )

    @tool
    def send_email(to: str, body: str) -> str:
        """Send an email."""
        return f"Sent to {to}"

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    cedar = CedarAuthorization(
        policies="""
          permit(
            principal,
            action == Action::"send_email",
            resource
          )
          when { context.session.call_count < 5 };

          permit(
            principal,
            action == Action::"search",
            resource
          );
        """,
    )

    agent = Agent(
        tools=[send_email, search],
        interventions=[cedar],
    )

    # send_email permitted for calls 1-4, denied on 5th
    # search is unlimited
    # --8<-- [end:rate_limit]


def schema_validation_example():
    # --8<-- [start:schema_validation]
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
        ToolDefinition,
    )

    search_def: ToolDefinition = {
        "name": "search",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            },
        },
    }

    delete_def: ToolDefinition = {
        "name": "delete_record",
        "inputSchema": {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"}
            },
        },
    }

    # Valid policies pass schema validation
    cedar = CedarAuthorization(
        policies="""
          permit(
            principal,
            action == Action::"search",
            resource
          );
          permit(
            principal,
            action == Action::"delete_record",
            resource
          )
          when { context.session.role == "admin" };
        """,
        tools=[search_def, delete_def],
        context_enricher=lambda ctx: {
            "role": ctx["invocation_state"].get(
                "role", "none"
            ),
        },
    )

    # A typo in the action name raises at construction:
    # CedarAuthorization(
    #     policies='permit(principal, action == Action::"deleet_record", resource);',
    #     tools=[search_def, delete_def],
    # )
    # raises ValueError: Cedar policy validation failed:
    #   unrecognized action "deleet_record"
    # --8<-- [end:schema_validation]


def namespace_example():
    # --8<-- [start:namespace]
    from strands import Agent, tool
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
        ToolDefinition,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    search_def: ToolDefinition = {
        "name": "search",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
    }

    cedar = CedarAuthorization(
        namespace="Agent",
        policies="""
          permit(
            principal,
            action == Agent::Action::"search",
            resource
          );
        """,
        tools=[search_def],
        entities=[
            {
                "uid": {
                    "type": "Agent::Resource",
                    "id": "default",
                },
                "attrs": {},
                "parents": [],
            }
        ],
        principal_resolver=lambda state: (
            {
                "type": "Agent::User",
                "id": state["user_id"],
            }
            if state.get("user_id")
            else None
        ),
    )

    agent = Agent(
        tools=[search],
        interventions=[cedar],
    )
    agent(
        "Search for reports",
        invocation_state={"user_id": "alice"},
    )
    # --8<-- [end:namespace]


def env_gating_example():
    # --8<-- [start:env_gating]
    from strands import Agent, tool
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
    )

    @tool
    def deploy(version: str) -> str:
        """Deploy the service."""
        return f"Deployed {version}"

    cedar = CedarAuthorization(
        policies="""
          permit(
            principal,
            action == Action::"deploy",
            resource
          )
          when {
            context.session has environment &&
            ["staging", "dev"].contains(
              context.session.environment
            )
          };
        """,
        context_enricher=lambda ctx: {
            "environment": ctx["invocation_state"].get(
                "environment", "unknown"
            ),
        },
    )

    agent = Agent(
        tools=[deploy],
        interventions=[cedar],
    )

    # works in staging
    agent(
        "Deploy the service",
        invocation_state={"environment": "staging"},
    )

    # denied in production
    agent(
        "Deploy the service",
        invocation_state={"environment": "production"},
    )

    # denied when environment is absent: the enricher falls
    # back to "unknown", which is outside the permitted set
    agent("Deploy the service")
    # --8<-- [end:env_gating]


def file_policies_example():
    # --8<-- [start:file_policies]
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
    )

    cedar = CedarAuthorization(
        policies="./policies/agent.cedar",
        entities="./policies/entities.json",
    )
    # --8<-- [end:file_policies]


def hot_reload_example():
    # --8<-- [start:hot_reload]
    from strands import Agent, tool
    from strands.vended_interventions.cedar import (
        CedarAuthorization,
    )

    @tool
    def search(query: str) -> str:
        """Search for information."""
        return f"Results for: {query}"

    cedar = CedarAuthorization(
        policies="./policies/agent.cedar",
    )

    agent = Agent(
        tools=[search],
        interventions=[cedar],
    )

    # After editing agent.cedar on disk:
    cedar.reload()
    # Validates new policies before applying.
    # Raises ValueError if invalid.
    # --8<-- [end:hot_reload]
