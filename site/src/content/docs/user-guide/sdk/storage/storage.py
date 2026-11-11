"""Storage documentation code examples."""


# --8<-- [start:agent_level]
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import S3Storage

storage = S3Storage("my-bucket", prefix="agents/prod/")

agent = Agent(
    storage=storage,
    session_manager=SnapshotSessionManager("my-session"),
    context_manager="auto",
)
# --8<-- [end:agent_level]


# --8<-- [start:per_plugin]
from strands import Agent
from strands.session import SnapshotSessionManager
from strands.storage import InMemoryStorage, S3Storage
from strands.vended_plugins.context_offloader import ContextOffloader

agent = Agent(
    session_manager=SnapshotSessionManager(
        "my-session", storage=S3Storage("my-bucket")
    ),
    plugins=[ContextOffloader(storage=InMemoryStorage())],
)
# --8<-- [end:per_plugin]


# --8<-- [start:in_memory]
from strands.storage import InMemoryStorage

storage = InMemoryStorage()
# --8<-- [end:in_memory]


# --8<-- [start:local_file]
from strands.storage import LocalFileStorage

storage = LocalFileStorage("./my-data/")
# --8<-- [end:local_file]


# --8<-- [start:s3]
from strands.storage import S3Storage

storage = S3Storage("my-bucket", prefix="agents/prod/")
# --8<-- [end:s3]
