"""A2A-compatible wrapper for Strands Agent.

This module provides the A2AServer class, which adapts a Strands Agent to the A2A protocol,
allowing it to be used in A2A-compatible systems.
"""

import logging
from typing import Any, Literal
from urllib.parse import urlparse

import uvicorn
from a2a.server.apps import A2AFastAPIApplication, A2AStarletteApplication
from a2a.server.events import QueueManager
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore, PushNotificationConfigStore, PushNotificationSender, TaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentSkill
from fastapi import FastAPI
from starlette.applications import Starlette

from ...agent.agent import Agent as SAAgent
from .executor import AgentFactory, StrandsA2AExecutor

logger = logging.getLogger(__name__)

# Placeholder context id used to build a representative agent for card metadata in factory mode.
_AGENT_CARD_CONTEXT_ID = "__agent_card__"


class A2AServer:
    """A2A-compatible wrapper for Strands Agent."""

    def __init__(
        self,
        agent: SAAgent | None = None,
        *,
        agent_factory: AgentFactory | None = None,
        max_contexts: int = StrandsA2AExecutor.DEFAULT_MAX_CONTEXTS,
        # AgentCard
        host: str = "127.0.0.1",
        port: int = 9000,
        http_url: str | None = None,
        serve_at_root: bool = False,
        version: str = "0.0.1",
        skills: list[AgentSkill] | None = None,
        # RequestHandler
        task_store: TaskStore | None = None,
        queue_manager: QueueManager | None = None,
        push_config_store: PushNotificationConfigStore | None = None,
        push_sender: PushNotificationSender | None = None,
        enable_a2a_compliant_streaming: bool = False,
    ):
        """Initialize an A2A-compatible server from a Strands agent.

        Provide exactly one of ``agent`` or ``agent_factory``:

        - ``agent_factory`` (recommended): a callable ``(context_id) -> Agent`` that builds a
          dedicated agent per A2A context. Contexts run concurrently and the factory is the place
          to wire per-context concerns such as a context-scoped ``session_manager``. The factory
          is invoked once at construction (with a placeholder context id) solely to derive the
          agent card metadata (name, description, skills); that agent is not used for request
          handling. An expensive factory therefore pays its cost once at startup.
        - ``agent`` (deprecated): a single agent serving one conversation. Not multi-tenant safe —
          every A2A context reuses the same instance — so use ``agent_factory`` for multi-caller
          deployments.

        Args:
            agent: A single Strands Agent to wrap. Deprecated; prefer ``agent_factory``.
            agent_factory: Callable ``(context_id) -> Agent`` building a fresh agent per context.
            max_contexts: Maximum number of per-context agents to retain concurrently (factory
                mode); the least-recently-used is evicted beyond this. Must be >= 1.
            host: The hostname or IP address to bind the A2A server to. Defaults to "127.0.0.1".
            port: The port to bind the A2A server to. Defaults to 9000.
            http_url: The public HTTP URL where this agent will be accessible. If provided,
                this overrides the generated URL from host/port and enables automatic
                path-based mounting for load balancer scenarios.
                Example: "http://my-alb.amazonaws.com/agent1"
            serve_at_root: If True, forces the server to serve at root path regardless of
                http_url path component. Use this when your load balancer strips path prefixes.
                Defaults to False.
            version: The version of the agent. Defaults to "0.0.1".
            skills: The list of capabilities or functions the agent can perform.
            task_store: Custom task store implementation for managing agent tasks. If None,
                uses InMemoryTaskStore.
            queue_manager: Custom queue manager for handling message queues. If None,
                no queue management is used.
            push_config_store: Custom store for push notification configurations. If None,
                no push notification configuration is used.
            push_sender: Custom push notification sender implementation. If None,
                no push notifications are sent.
            enable_a2a_compliant_streaming: If True, uses A2A-compliant streaming with
                artifact updates. If False, uses legacy status updates streaming behavior
                for backwards compatibility. Defaults to False.

        Raises:
            ValueError: If neither or both of ``agent``/``agent_factory`` are provided, or if
                ``max_contexts`` is less than 1.
        """
        if (agent is None) == (agent_factory is None):
            raise ValueError("Provide exactly one of 'agent' or 'agent_factory'.")

        self.host = host
        self.port = port
        self.version = version

        if http_url:
            # Parse the provided URL to extract components for mounting
            self.public_base_url, self.mount_path = self._parse_public_url(http_url)
            self.http_url = http_url.rstrip("/") + "/"
            self._http_url_explicit = True

            # Override mount path if serve_at_root is requested
            if serve_at_root:
                self.mount_path = ""
        else:
            # Fall back to constructing the URL from host and port
            self.public_base_url = f"http://{host}:{port}"
            self.http_url = f"{self.public_base_url}/"
            self.mount_path = ""
            self._http_url_explicit = False

        # The agent used to derive card metadata (name/description/skills). With a factory, build
        # a representative agent once; per-request agents are created lazily by the executor.
        self.strands_agent = agent if agent is not None else agent_factory(_AGENT_CARD_CONTEXT_ID)  # type: ignore[misc]
        self.name = self.strands_agent.name
        self.description = self.strands_agent.description
        self.capabilities = AgentCapabilities(streaming=True)
        self.request_handler = DefaultRequestHandler(
            agent_executor=StrandsA2AExecutor(
                agent,
                agent_factory=agent_factory,
                enable_a2a_compliant_streaming=enable_a2a_compliant_streaming,
                max_contexts=max_contexts,
            ),
            task_store=task_store or InMemoryTaskStore(),
            queue_manager=queue_manager,
            push_config_store=push_config_store,
            push_sender=push_sender,
        )
        self._agent_skills = skills
        self._agent_card_url: str | None = None
        logger.info("Strands' integration with A2A is experimental. Be aware of frequent breaking changes.")

    def _parse_public_url(self, url: str) -> tuple[str, str]:
        """Parse the public URL into base URL and mount path components.

        Args:
            url: The full public URL (e.g., "http://my-alb.amazonaws.com/agent1")

        Returns:
            tuple: (base_url, mount_path) where base_url is the scheme+netloc
                  and mount_path is the path component

        Example:
            _parse_public_url("http://my-alb.amazonaws.com/agent1")
            Returns: ("http://my-alb.amazonaws.com", "/agent1")
        """
        parsed = urlparse(url.rstrip("/"))
        base_url = f"{parsed.scheme}://{parsed.netloc}"
        mount_path = parsed.path if parsed.path != "/" else ""
        return base_url, mount_path

    @property
    def public_agent_card(self) -> AgentCard:
        """Get the public AgentCard for this agent.

        The AgentCard contains metadata about the agent, including its name,
        description, URL, version, skills, and capabilities. This information
        is used by other agents and systems to discover and interact with this agent.

        Returns:
            AgentCard: The public agent card containing metadata about this agent.

        Raises:
            ValueError: If name or description is None or empty.
        """
        if not self.name:
            raise ValueError("A2A agent name cannot be None or empty")
        if not self.description:
            raise ValueError("A2A agent description cannot be None or empty")

        return AgentCard(
            name=self.name,
            description=self.description,
            url=self.agent_card_url,
            version=self.version,
            skills=self.agent_skills,
            default_input_modes=["text"],
            default_output_modes=["text"],
            capabilities=self.capabilities,
        )

    def _get_skills_from_tools(self) -> list[AgentSkill]:
        """Get the list of skills from Strands agent tools.

        Skills represent specific capabilities that the agent can perform.
        Strands agent tools are adapted to A2A skills.

        Returns:
            list[AgentSkill]: A list of skills this agent provides.
        """
        return [
            AgentSkill(name=config["name"], id=config["name"], description=config["description"], tags=[])
            for config in self.strands_agent.tool_registry.get_all_tools_config().values()
        ]

    @property
    def agent_card_url(self) -> str:
        """Get the URL advertised in the AgentCard.

        Defaults to http_url. Can be overridden to advertise a custom URL
        (e.g., without trailing slash or with a different base).
        """
        return self._agent_card_url if self._agent_card_url is not None else self.http_url

    @agent_card_url.setter
    def agent_card_url(self, url: str) -> None:
        """Override the URL advertised in the AgentCard.

        Args:
            url: The URL to advertise in the AgentCard.
        """
        self._agent_card_url = url

    @property
    def agent_skills(self) -> list[AgentSkill]:
        """Get the list of skills this agent provides."""
        return self._agent_skills if self._agent_skills is not None else self._get_skills_from_tools()

    @agent_skills.setter
    def agent_skills(self, skills: list[AgentSkill]) -> None:
        """Set the list of skills this agent provides.

        Args:
            skills: A list of AgentSkill objects to set for this agent.
        """
        self._agent_skills = skills

    def to_starlette_app(self, *, app_kwargs: dict[str, Any] | None = None) -> Starlette:
        """Create a Starlette application for serving this agent via HTTP.

        Automatically handles path-based mounting if a mount path was derived
        from the http_url parameter.

        Args:
            app_kwargs: Additional keyword arguments to pass to the Starlette constructor.

        Returns:
            Starlette: A Starlette application configured to serve this agent.
        """
        a2a_app = A2AStarletteApplication(agent_card=self.public_agent_card, http_handler=self.request_handler).build(
            **app_kwargs or {}
        )

        if self.mount_path:
            # Create parent app and mount the A2A app at the specified path
            parent_app = Starlette()
            parent_app.mount(self.mount_path, a2a_app)
            logger.info("Mounting A2A server at path: %s", self.mount_path)
            return parent_app

        return a2a_app

    def to_fastapi_app(self, *, app_kwargs: dict[str, Any] | None = None) -> FastAPI:
        """Create a FastAPI application for serving this agent via HTTP.

        Automatically handles path-based mounting if a mount path was derived
        from the http_url parameter.

        Args:
            app_kwargs: Additional keyword arguments to pass to the FastAPI constructor.

        Returns:
            FastAPI: A FastAPI application configured to serve this agent.
        """
        a2a_app = A2AFastAPIApplication(agent_card=self.public_agent_card, http_handler=self.request_handler).build(
            **app_kwargs or {}
        )

        if self.mount_path:
            # Create parent app and mount the A2A app at the specified path
            parent_app = FastAPI()
            parent_app.mount(self.mount_path, a2a_app)
            logger.info("Mounting A2A server at path: %s", self.mount_path)
            return parent_app

        return a2a_app

    def serve(
        self,
        app_type: Literal["fastapi", "starlette"] = "starlette",
        *,
        host: str | None = None,
        port: int | None = None,
        **kwargs: Any,
    ) -> None:
        """Start the A2A server with the specified application type.

        This method starts an HTTP server that exposes the agent via the A2A protocol.
        The server can be implemented using either FastAPI or Starlette, depending on
        the specified app_type.

        Args:
            app_type: The type of application to serve, either "fastapi" or "starlette".
                Defaults to "starlette".
            host: The host address to bind the server to. Defaults to "0.0.0.0".
            port: The port number to bind the server to. Defaults to 9000.
            **kwargs: Additional keyword arguments to pass to uvicorn.run.
        """
        # Update host/port if overridden, and recalculate URLs if http_url wasn't explicitly set
        if host is not None:
            self.host = host
        if port is not None:
            self.port = port

        if host is not None or port is not None:
            # Only update the URL if it wasn't explicitly set via http_url parameter
            # (i.e., if the URL was auto-generated from host/port in __init__)
            if not self._http_url_explicit:
                self.public_base_url = f"http://{self.host}:{self.port}"
                self.http_url = f"{self.public_base_url}/"

        try:
            logger.info("Starting Strands A2A server...")
            if app_type == "fastapi":
                uvicorn.run(self.to_fastapi_app(), host=self.host, port=self.port, **kwargs)
            else:
                uvicorn.run(self.to_starlette_app(), host=self.host, port=self.port, **kwargs)
        except KeyboardInterrupt:
            logger.warning("Strands A2A server shutdown requested (KeyboardInterrupt).")
        except Exception:
            logger.exception("Strands A2A server encountered exception.")
        finally:
            logger.info("Strands A2A server has shutdown.")
