"""Unit tests for ToolRegistry ToolProvider functionality."""

from unittest.mock import patch

import pytest

from strands.tools import ToolProvider
from strands.tools.registry import ToolRegistry
from tests.fixtures.mock_agent_tool import MockAgentTool


class MockToolProvider(ToolProvider):
    """Mock ToolProvider for testing."""

    def __init__(self, tools=None, cleanup_error=None):
        self._tools = tools or []
        self._cleanup_error = cleanup_error
        self.cleanup_called = False
        self.remove_consumer_called = False
        self.remove_consumer_id = None
        self.add_consumer_called = False
        self.add_consumer_id = None

    async def load_tools(self):
        return self._tools

    def cleanup(self):
        self.cleanup_called = True
        if self._cleanup_error:
            raise self._cleanup_error

    def add_consumer(self, consumer_id):
        self.add_consumer_called = True
        self.add_consumer_id = consumer_id

    def remove_consumer(self, consumer_id):
        self.remove_consumer_called = True
        self.remove_consumer_id = consumer_id
        if self._cleanup_error:
            raise self._cleanup_error


@pytest.fixture
def mock_run_async():
    """Fixture for mocking strands.tools.registry.run_async."""
    with patch("strands.tools.registry.run_async") as mock:
        yield mock


@pytest.fixture
def mock_agent_tool():
    """Fixture factory for creating MockAgentTool instances."""
    return MockAgentTool


class TestToolRegistryToolProvider:
    """Test ToolRegistry integration with ToolProvider."""

    def test_process_tools_with_tool_provider(self, mock_run_async, mock_agent_tool):
        """Test that process_tools handles ToolProvider correctly."""
        # Create mock tools
        mock_tool1 = mock_agent_tool("provider_tool_1")
        mock_tool2 = mock_agent_tool("provider_tool_2")

        # Create mock provider
        provider = MockToolProvider([mock_tool1, mock_tool2])

        registry = ToolRegistry()

        # Mock run_async to return the tools directly
        mock_run_async.return_value = [mock_tool1, mock_tool2]

        tool_names = registry.process_tools([provider])

        # Verify run_async was called with the provider's load_tools method
        mock_run_async.assert_called_once()

        # Verify tools were registered
        assert "provider_tool_1" in tool_names
        assert "provider_tool_2" in tool_names
        assert len(tool_names) == 2

        # Verify provider was tracked
        assert provider in registry._tool_providers

        # Verify tools are in registry
        assert registry.registry["provider_tool_1"] is mock_tool1
        assert registry.registry["provider_tool_2"] is mock_tool2

    def test_process_tools_with_multiple_providers(self, mock_run_async, mock_agent_tool):
        """Test that process_tools handles multiple ToolProviders."""
        # Create mock tools for first provider
        mock_tool1 = mock_agent_tool("provider1_tool")
        provider1 = MockToolProvider([mock_tool1])

        # Create mock tools for second provider
        mock_tool2 = mock_agent_tool("provider2_tool")
        provider2 = MockToolProvider([mock_tool2])

        registry = ToolRegistry()

        # Mock run_async to return appropriate tools for each call
        mock_run_async.side_effect = [[mock_tool1], [mock_tool2]]

        tool_names = registry.process_tools([provider1, provider2])

        # Verify run_async was called twice
        assert mock_run_async.call_count == 2

        # Verify all tools were registered
        assert "provider1_tool" in tool_names
        assert "provider2_tool" in tool_names
        assert len(tool_names) == 2

        # Verify both providers were tracked
        assert provider1 in registry._tool_providers
        assert provider2 in registry._tool_providers
        assert len(registry._tool_providers) == 2

    def test_process_tools_with_mixed_tools_and_providers(self, mock_run_async, mock_agent_tool):
        """Test that process_tools handles mix of regular tools and providers."""
        # Create regular tool
        regular_tool = mock_agent_tool("regular_tool")

        # Create provider tool
        provider_tool = mock_agent_tool("provider_tool")
        provider = MockToolProvider([provider_tool])

        registry = ToolRegistry()

        mock_run_async.return_value = [provider_tool]

        tool_names = registry.process_tools([regular_tool, provider])

        # Verify both tools were registered
        assert "regular_tool" in tool_names
        assert "provider_tool" in tool_names
        assert len(tool_names) == 2

        # Verify only provider was tracked
        assert provider in registry._tool_providers
        assert len(registry._tool_providers) == 1

    def test_process_tools_with_empty_provider(self, mock_run_async):
        """Test that process_tools handles provider with no tools."""
        provider = MockToolProvider([])  # Empty tools list

        registry = ToolRegistry()

        mock_run_async.return_value = []

        tool_names = registry.process_tools([provider])

        # Verify no tools were registered
        assert not tool_names

        # Verify provider was still tracked
        assert provider in registry._tool_providers

    def test_tool_providers_public_access(self):
        """Test that tool_providers can be accessed directly."""
        provider1 = MockToolProvider()
        provider2 = MockToolProvider()

        registry = ToolRegistry()
        registry._tool_providers = [provider1, provider2]

        # Verify direct access works
        assert len(registry._tool_providers) == 2
        assert provider1 in registry._tool_providers
        assert provider2 in registry._tool_providers

    def test_tool_providers_empty_by_default(self):
        """Test that tool_providers is empty by default."""
        registry = ToolRegistry()

        assert not registry._tool_providers
        assert isinstance(registry._tool_providers, list)

    def test_process_tools_provider_load_exception(self, mock_run_async):
        """Test that process_tools handles exceptions from provider.load_tools()."""
        provider = MockToolProvider()

        registry = ToolRegistry()

        # Make load_tools raise an exception
        mock_run_async.side_effect = Exception("Load tools failed")

        # Should raise the exception from load_tools
        with pytest.raises(Exception, match="Load tools failed"):
            registry.process_tools([provider])

        # Provider should still be tracked even if load_tools failed
        assert provider in registry._tool_providers

    def test_tool_provider_tracking_persistence(self, mock_run_async, mock_agent_tool):
        """Test that tool providers are tracked across multiple process_tools calls."""
        provider1 = MockToolProvider([mock_agent_tool("tool1")])
        provider2 = MockToolProvider([mock_agent_tool("tool2")])

        registry = ToolRegistry()

        mock_run_async.side_effect = [
            [mock_agent_tool("tool1")],
            [mock_agent_tool("tool2")],
        ]

        # Process first provider
        registry.process_tools([provider1])
        assert len(registry._tool_providers) == 1
        assert provider1 in registry._tool_providers

        # Process second provider
        registry.process_tools([provider2])
        assert len(registry._tool_providers) == 2
        assert provider1 in registry._tool_providers
        assert provider2 in registry._tool_providers

    def test_process_tools_provider_async_optimization(self, mock_agent_tool):
        """Test that load_tools and add_consumer are called in same async context."""
        mock_tool = mock_agent_tool("test_tool")

        class TestProvider(ToolProvider):
            def __init__(self):
                self.load_tools_called = False
                self.add_consumer_called = False
                self.add_consumer_id = None

            async def load_tools(self):
                self.load_tools_called = True
                return [mock_tool]

            def add_consumer(self, consumer_id):
                self.add_consumer_called = True
                self.add_consumer_id = consumer_id

            def remove_consumer(self, consumer_id):
                pass

        provider = TestProvider()
        registry = ToolRegistry()

        # Process the provider - this should call both methods
        tool_names = registry.process_tools([provider])

        # Verify both methods were called
        assert provider.load_tools_called
        assert provider.add_consumer_called
        assert provider.add_consumer_id == registry._registry_id

        # Verify tool was registered
        assert "test_tool" in tool_names
        assert provider in registry._tool_providers

    def test_registry_cleanup(self):
        """Test that registry cleanup calls remove_consumer on all providers."""
        provider1 = MockToolProvider()
        provider2 = MockToolProvider()

        registry = ToolRegistry()
        registry._tool_providers = [provider1, provider2]

        registry.cleanup()

        # Verify both providers had remove_consumer called
        assert provider1.remove_consumer_called
        assert provider2.remove_consumer_called

    def test_registry_cleanup_with_provider_consumer_removal(self):
        """Test that cleanup removes provider consumers correctly."""

        class TestProvider(ToolProvider):
            def __init__(self):
                self.remove_consumer_called = False
                self.remove_consumer_id = None

            async def load_tools(self):
                return []

            def add_consumer(self, consumer_id):
                pass

            def remove_consumer(self, consumer_id):
                self.remove_consumer_called = True
                self.remove_consumer_id = consumer_id

        provider = TestProvider()
        registry = ToolRegistry()
        registry._tool_providers = [provider]

        # Call cleanup
        registry.cleanup()

        # Verify remove_consumer was called with correct ID
        assert provider.remove_consumer_called
        assert provider.remove_consumer_id == registry._registry_id

    def test_registry_cleanup_raises_exception_on_provider_error(self):
        """Test that cleanup raises exception when provider removal fails."""
        provider1 = MockToolProvider(cleanup_error=RuntimeError("Provider cleanup failed"))
        provider2 = MockToolProvider()

        registry = ToolRegistry()
        registry._tool_providers = [provider1, provider2]

        # Cleanup should raise the exception from first provider but still attempt cleanup of all
        with pytest.raises(RuntimeError, match="Provider cleanup failed"):
            registry.cleanup()

        # Both providers should have had remove_consumer called
        assert provider1.remove_consumer_called
        assert provider2.remove_consumer_called

    def test_registry_cleanup_raises_first_exception_on_multiple_provider_errors(self):
        """Test that cleanup raises first exception when multiple providers fail but attempts all."""
        provider1 = MockToolProvider(cleanup_error=RuntimeError("Provider 1 failed"))
        provider2 = MockToolProvider(cleanup_error=ValueError("Provider 2 failed"))

        registry = ToolRegistry()
        registry._tool_providers = [provider1, provider2]

        # Cleanup should raise first exception but still attempt cleanup of all
        with pytest.raises(RuntimeError, match="Provider 1 failed"):
            registry.cleanup()

        # Both providers should have had remove_consumer called
        assert provider1.remove_consumer_called
        assert provider2.remove_consumer_called
