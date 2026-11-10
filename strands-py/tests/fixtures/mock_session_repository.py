from strands.session.session_repository import SessionRepository
from strands.types.exceptions import SessionException
from strands.types.session import SessionAgent, SessionMessage


class MockedSessionRepository(SessionRepository):
    """Mock repository for testing."""

    def __init__(self):
        """Initialize with empty storage."""
        self.sessions = {}
        self.agents = {}
        self.messages = {}
        self.multi_agents = {}

    def create_session(self, session) -> None:
        """Create a session."""
        session_id = session.session_id
        if session_id in self.sessions:
            raise SessionException(f"Session {session_id} already exists")
        self.sessions[session_id] = session
        self.agents[session_id] = {}
        self.messages[session_id] = {}
        self.multi_agents[session_id] = {}

    def read_session(self, session_id) -> SessionAgent:
        """Read a session."""
        return self.sessions.get(session_id)

    def create_agent(self, session_id, session_agent) -> None:
        """Create an agent."""
        agent_id = session_agent.agent_id
        if session_id not in self.sessions:
            raise SessionException(f"Session {session_id} does not exist")
        if agent_id in self.agents.get(session_id, {}):
            raise SessionException(f"Agent {agent_id} already exists in session {session_id}")
        self.agents.setdefault(session_id, {})[agent_id] = session_agent
        self.messages.setdefault(session_id, {}).setdefault(agent_id, {})
        return session_agent

    def read_agent(self, session_id, agent_id) -> SessionAgent:
        """Read an agent."""
        if session_id not in self.sessions:
            return None
        return self.agents.get(session_id, {}).get(agent_id)

    def update_agent(self, session_id, session_agent) -> None:
        """Update an agent."""
        agent_id = session_agent.agent_id
        if session_id not in self.sessions:
            raise SessionException(f"Session {session_id} does not exist")
        if agent_id not in self.agents.get(session_id, {}):
            raise SessionException(f"Agent {agent_id} does not exist in session {session_id}")
        self.agents[session_id][agent_id] = session_agent

    def create_message(self, session_id, agent_id, session_message) -> None:
        """Create a message."""
        message_id = session_message.message_id
        if session_id not in self.sessions:
            raise SessionException(f"Session {session_id} does not exist")
        if agent_id not in self.agents.get(session_id, {}):
            raise SessionException(f"Agent {agent_id} does not exists in session {session_id}")
        if message_id in self.messages.get(session_id, {}).get(agent_id, {}):
            raise SessionException(f"Message {message_id} already exists in agent {agent_id} in session {session_id}")
        self.messages.setdefault(session_id, {}).setdefault(agent_id, {})[message_id] = session_message

    def read_message(self, session_id, agent_id, message_id) -> SessionMessage:
        """Read a message."""
        if session_id not in self.sessions:
            return None
        if agent_id not in self.agents.get(session_id, {}):
            return None
        return self.messages.get(session_id, {}).get(agent_id, {}).get(message_id)

    def update_message(self, session_id, agent_id, session_message) -> None:
        """Update a message."""

        message_id = session_message.message_id
        if session_id not in self.sessions:
            raise SessionException(f"Session {session_id} does not exist")
        if agent_id not in self.agents.get(session_id, {}):
            raise SessionException(f"Agent {agent_id} does not exist in session {session_id}")
        if message_id not in self.messages.get(session_id, {}).get(agent_id, {}):
            raise SessionException(f"Message {message_id} does not exist in session {session_id}")
        self.messages[session_id][agent_id][message_id] = session_message

    def list_messages(self, session_id, agent_id, limit=None, offset=0) -> list[SessionMessage]:
        """List messages."""
        if session_id not in self.sessions:
            return []
        if agent_id not in self.agents.get(session_id, {}):
            return []

        messages = self.messages.get(session_id, {}).get(agent_id, {})
        sorted_messages = [messages[key] for key in sorted(messages.keys())]

        if limit is not None:
            return sorted_messages[offset : offset + limit]
        return sorted_messages[offset:]

    def create_multi_agent(self, session_id, multi_agent, **kwargs) -> None:
        """Create multi-agent state."""
        multi_agent_id = multi_agent.id
        if session_id not in self.sessions:
            raise SessionException(f"Session {session_id} does not exist")
        state = multi_agent.serialize_state()
        self.multi_agents.setdefault(session_id, {})[multi_agent_id] = state

    def read_multi_agent(self, session_id, multi_agent_id, **kwargs):
        """Read multi-agent state."""
        if session_id not in self.sessions:
            return None
        return self.multi_agents.get(session_id, {}).get(multi_agent_id)

    def update_multi_agent(self, session_id, multi_agent, **kwargs) -> None:
        """Update multi-agent state."""
        multi_agent_id = multi_agent.id
        if session_id not in self.sessions:
            raise SessionException(f"Session {session_id} does not exist")
        if multi_agent_id not in self.multi_agents.get(session_id, {}):
            raise SessionException(f"MultiAgent {multi_agent} does not exist in session {session_id}")
        state = multi_agent.serialize_state()
        self.multi_agents[session_id][multi_agent_id] = state
