from strands import Agent
from strands.multiagent.a2a import A2AServer

# Create an agent and serve it over A2A
agent = Agent(
    name="Test agent",
    description="Test description here",
    callback_handler=None,
)
a2a_server = A2AServer(
    agent=agent,
    host="localhost",
    port=9000,
)
a2a_server.serve()
