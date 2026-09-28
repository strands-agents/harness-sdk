"""Unit tests for MCPClient.load_servers (mcpServers JSON config loading)."""

import json
from unittest.mock import ANY, patch

import pytest

from strands.tools.mcp._compat import MCP_V2
from strands.tools.mcp.mcp_client import MCPClient

# mcp 2.x renamed the provider's `scopes` keyword to `scope`.
SCOPE_KWARG = "scope" if MCP_V2 else "scopes"


@pytest.fixture
def mock_client():
    """Patch MCPClient.__init__ so load_servers builds instances without opening connections.

    Records the (transport_callable, kwargs) each client was constructed with.
    """
    calls = []

    def fake_init(self, transport_callable, **kwargs):
        calls.append((transport_callable, kwargs))

    with patch.object(MCPClient, "__init__", fake_init):
        yield calls


@pytest.fixture
def transports():
    """Patch the three transport constructors as imported into mcp_client."""
    with (
        patch("strands.tools.mcp.mcp_client.stdio_client") as stdio,
        patch("strands.tools.mcp.mcp_client.streamable_http_transport") as http,
        patch("strands.tools.mcp.mcp_client.sse_client") as sse,
        patch("strands.tools.mcp.mcp_client.StdioServerParameters") as params,
    ):
        yield {"stdio": stdio, "http": http, "sse": sse, "params": params}


def _open(callable_):
    """Invoke a returned transport callable so its underlying constructor is exercised."""
    return callable_()


# Transport Detection Tests


def test_command_detects_stdio(mock_client, transports):
    clients = MCPClient.load_servers({"srv": {"command": "node", "args": ["server.js"]}})
    assert len(clients) == 1
    _open(mock_client[0][0])
    transports["params"].assert_called_once_with(command="node", args=["server.js"], env=None, cwd=None)
    transports["stdio"].assert_called_once()


def test_url_detects_streamable_http(mock_client, transports):
    clients = MCPClient.load_servers({"srv": {"url": "https://example.com/mcp"}})
    assert len(clients) == 1
    _open(mock_client[0][0])
    transports["http"].assert_called_once_with(url="https://example.com/mcp", headers=None, auth=None)
    transports["sse"].assert_not_called()


def test_explicit_sse(mock_client, transports):
    clients = MCPClient.load_servers({"srv": {"url": "https://example.com/sse", "transport": "sse"}})
    assert len(clients) == 1
    _open(mock_client[0][0])
    transports["sse"].assert_called_once_with(url="https://example.com/sse", headers=None)
    transports["http"].assert_not_called()


def test_explicit_transport_overrides_detection(mock_client, transports):
    MCPClient.load_servers({"srv": {"url": "https://example.com/mcp", "transport": "sse"}})
    _open(mock_client[0][0])
    transports["sse"].assert_called_once()
    transports["http"].assert_not_called()


# Environment Variable Interpolation Tests


def test_interpolates_bare_var_in_env(mock_client, transports, monkeypatch):
    monkeypatch.setenv("MY_SECRET", "secret123")
    MCPClient.load_servers({"srv": {"command": "node", "env": {"SECRET": "${MY_SECRET}"}}})
    _open(mock_client[0][0])
    transports["params"].assert_called_once_with(command="node", args=[], env={"SECRET": "secret123"}, cwd=None)


def test_interpolates_namespaced_env_syntax(mock_client, transports, monkeypatch):
    monkeypatch.setenv("MY_TOKEN", "token123")
    MCPClient.load_servers({"srv": {"command": "node", "env": {"TOKEN": "${env:MY_TOKEN}"}}})
    _open(mock_client[0][0])
    transports["params"].assert_called_once_with(command="node", args=[], env={"TOKEN": "token123"}, cwd=None)


def test_interpolates_in_headers(mock_client, transports, monkeypatch):
    monkeypatch.setenv("TOKEN", "abc")
    MCPClient.load_servers({"srv": {"url": "https://example.com/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"}}})
    _open(mock_client[0][0])
    transports["http"].assert_called_once_with(
        url="https://example.com/mcp", headers={"Authorization": "Bearer abc"}, auth=None
    )


def test_interpolates_in_command_and_args(mock_client, transports, monkeypatch):
    monkeypatch.setenv("MY_CMD", "/usr/local/bin/server")
    monkeypatch.setenv("MY_ARG", "3000")
    MCPClient.load_servers({"srv": {"command": "${MY_CMD}", "args": ["--port=${MY_ARG}"]}})
    _open(mock_client[0][0])
    transports["params"].assert_called_once_with(
        command="/usr/local/bin/server", args=["--port=3000"], env=None, cwd=None
    )


def test_missing_env_var_raises(mock_client, transports):
    with pytest.raises(ValueError, match="environment variable 'NONEXISTENT_VAR' is not set"):
        MCPClient.load_servers({"srv": {"command": "node", "env": {"V": "${NONEXISTENT_VAR}"}}})


def test_malformed_placeholder_not_interpolated(mock_client, transports):
    # `${ }` is not a valid identifier; the strict pattern leaves it untouched rather than erroring.
    MCPClient.load_servers({"srv": {"command": "node", "args": ["${ }"]}})
    _open(mock_client[0][0])
    transports["params"].assert_called_once_with(command="node", args=["${ }"], env=None, cwd=None)


# Path Expansion Tests


def test_expands_tilde_in_command_and_cwd(mock_client, transports):
    # Patch expanduser to a fixed home so the assertion holds regardless of platform.
    with patch("os.path.expanduser", lambda p: p.replace("~", "/home/user")):
        MCPClient.load_servers({"srv": {"command": "~/bin/server", "cwd": "~/project"}})
    _open(mock_client[0][0])
    transports["params"].assert_called_once_with(
        command="/home/user/bin/server", args=[], env=None, cwd="/home/user/project"
    )


# Per-Server Option Tests


def test_prefix_and_startup_timeout_passed(mock_client, transports):
    MCPClient.load_servers({"srv": {"command": "node", "prefix": "p", "startup_timeout": 5}})
    _, kwargs = mock_client[0]
    assert kwargs == {
        "startup_timeout": 5,
        "tool_filters": None,
        "prefix": "p",
        "continue_on_error": False,
        "application_name": "srv",
        "application_version": None,
    }


def test_default_startup_timeout(mock_client, transports):
    MCPClient.load_servers({"srv": {"command": "node"}})
    assert mock_client[0][1] == {
        "startup_timeout": 30,
        "tool_filters": None,
        "prefix": None,
        "continue_on_error": False,
        "application_name": "srv",
        "application_version": None,
    }


def test_prefix_with_server_name_uses_config_key(mock_client, transports):
    MCPClient.load_servers({"slack": {"command": "node"}}, prefix_with_server_name=True)
    assert mock_client[0][1]["prefix"] == "slack"


def test_prefix_with_server_name_sanitizes_config_key(mock_client, transports):
    MCPClient.load_servers({"awslabs.aws-docs mcp/server": {"command": "node"}}, prefix_with_server_name=True)
    assert mock_client[0][1]["prefix"] == "awslabs_aws-docs_mcp_server"
    assert mock_client[0][1]["application_name"] == "awslabs.aws-docs mcp/server"


def test_prefix_with_server_name_explicit_prefix_is_not_sanitized(mock_client, transports):
    MCPClient.load_servers({"slack": {"command": "node", "prefix": "a.b"}}, prefix_with_server_name=True)
    assert mock_client[0][1]["prefix"] == "a.b"


def test_prefix_with_server_name_explicit_prefix_wins(mock_client, transports):
    MCPClient.load_servers({"slack": {"command": "node", "prefix": "chat"}}, prefix_with_server_name=True)
    assert mock_client[0][1]["prefix"] == "chat"


def test_prefix_with_server_name_empty_prefix_opts_out(mock_client, transports):
    MCPClient.load_servers({"slack": {"command": "node", "prefix": ""}}, prefix_with_server_name=True)
    assert mock_client[0][1]["prefix"] == ""


def test_tool_filters_compiled_to_regex(mock_client, transports):
    MCPClient.load_servers(
        {"srv": {"command": "node", "tool_filters": {"allowed": ["search_.*"], "rejected": ["^delete_"]}}}
    )
    filters = mock_client[0][1]["tool_filters"]
    assert [p.pattern for p in filters["allowed"]] == ["search_.*"]
    assert [p.pattern for p in filters["rejected"]] == ["^delete_"]


def test_invalid_regex_raises(mock_client, transports):
    with pytest.raises(ValueError, match="invalid regex in tool_filters.allowed"):
        MCPClient.load_servers({"srv": {"command": "node", "tool_filters": {"allowed": ["([unclosed"]}}})


def test_unknown_config_key_warns(mock_client, transports, caplog):
    with caplog.at_level("WARNING", logger="strands.tools.mcp.mcp_client"):
        MCPClient.load_servers({"srv": {"command": "node", "startup_timout": 5}})
    assert "startup_timout" in caplog.text


# File Loading Tests


def test_loads_from_file(mock_client, transports, tmp_path):
    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"srv": {"command": "node"}}))
    clients = MCPClient.load_servers(str(cfg))
    assert len(clients) == 1


def test_extracts_mcp_servers_key(mock_client, transports, tmp_path):
    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"mcpServers": {"a": {"command": "node"}, "b": {"url": "https://x.com"}}}))
    clients = MCPClient.load_servers(str(cfg))
    assert len(clients) == 2
    # Verify each entry wired to the right transport, not just that two clients were created.
    _open(mock_client[0][0])
    _open(mock_client[1][0])
    transports["stdio"].assert_called_once()
    transports["http"].assert_called_once_with(url="https://x.com", headers=None, auth=None)


def test_flat_object_without_wrapper(mock_client, transports, tmp_path):
    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"a": {"command": "node"}}))
    assert len(MCPClient.load_servers(str(cfg))) == 1


def test_file_uri_prefix_stripped(mock_client, transports, tmp_path):
    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"srv": {"command": "node"}}))
    assert len(MCPClient.load_servers(f"file://{cfg}")) == 1


def test_missing_file_raises(mock_client, transports):
    with pytest.raises(FileNotFoundError, match="MCP configuration file not found"):
        MCPClient.load_servers("/nonexistent/path.json")


def test_malformed_json_raises(mock_client, transports, tmp_path):
    cfg = tmp_path / "bad.json"
    cfg.write_text("not json{{{")
    with pytest.raises(json.JSONDecodeError):
        MCPClient.load_servers(str(cfg))


# Error Case Tests


def test_neither_command_nor_url(mock_client, transports):
    with pytest.raises(ValueError, match="must include either 'command'"):
        MCPClient.load_servers({"bad": {}})


def test_both_command_and_url_without_transport(mock_client, transports):
    with pytest.raises(ValueError, match="has both 'command' and 'url'"):
        MCPClient.load_servers({"bad": {"command": "node", "url": "https://x.com"}})


def test_stdio_without_command(mock_client, transports):
    with pytest.raises(ValueError, match="stdio transport requires 'command'"):
        MCPClient.load_servers({"bad": {"transport": "stdio", "url": "https://x.com"}})


def test_streamable_http_without_url(mock_client, transports):
    with pytest.raises(ValueError, match="streamable-http transport requires 'url'"):
        MCPClient.load_servers({"bad": {"transport": "streamable-http", "command": "node"}})


def test_sse_without_url(mock_client, transports):
    with pytest.raises(ValueError, match="sse transport requires 'url'"):
        MCPClient.load_servers({"bad": {"transport": "sse", "command": "node"}})


def test_non_dict_server_entry(mock_client, transports):
    with pytest.raises(ValueError, match="server 'bad' configuration must be a dictionary"):
        MCPClient.load_servers({"bad": "oops"})


def test_invalid_config_shape(mock_client, transports, tmp_path):
    cfg = tmp_path / "bad.json"
    cfg.write_text(json.dumps([1, 2, 3]))
    with pytest.raises(ValueError, match="MCP config must be a JSON object"):
        MCPClient.load_servers(str(cfg))


def test_non_str_non_dict_config(mock_client, transports):
    with pytest.raises(ValueError, match="config must be a file path string or a dictionary"):
        MCPClient.load_servers(123)  # type: ignore[arg-type]


# Disabled Server Tests


def test_skips_disabled_servers(mock_client, transports):
    clients = MCPClient.load_servers({"active": {"command": "node"}, "inactive": {"command": "node", "disabled": True}})
    assert len(clients) == 1


# continue_on_error Tests


def test_continue_on_error_skips_server_with_failed_config(mock_client, transports):
    """An early server whose config fails to resolve is skipped, leaving later servers loadable."""
    clients = MCPClient.load_servers(
        {
            "broken": {"command": "node", "env": {"V": "${NONEXISTENT_VAR}"}, "continue_on_error": True},
            "ok": {"url": "https://example.com/mcp"},
        }
    )
    assert len(clients) == 1
    # The one surviving client must be "ok" (http), not the broken stdio server that failed to build.
    _open(mock_client[0][0])
    transports["http"].assert_called_once_with(url="https://example.com/mcp", headers=None, auth=None)
    transports["stdio"].assert_not_called()


def test_continue_on_error_logs_warning(mock_client, transports, caplog):
    with caplog.at_level("WARNING", logger="strands.tools.mcp.mcp_client"):
        MCPClient.load_servers(
            {"broken": {"command": "node", "env": {"V": "${NONEXISTENT_VAR}"}, "continue_on_error": True}}
        )
    assert "MCP server config failed, skipping" in caplog.text


def test_continue_on_error_passed_to_client(mock_client, transports):
    """The config flag is threaded through to the constructed client so its runtime honors it."""
    MCPClient.load_servers({"srv": {"command": "node", "continue_on_error": True}})
    assert mock_client[0][1]["continue_on_error"] is True


def test_continue_on_error_default_skips_failed_server_and_passes_to_client(mock_client, transports):
    clients = MCPClient.load_servers(
        {"bad": {"command": "${MISSING_VAR_XYZ}"}, "good": {"command": "node"}}, continue_on_error=True
    )
    assert len(clients) == 1
    assert mock_client[0][1]["continue_on_error"] is True


def test_continue_on_error_server_key_overrides_default(mock_client, transports):
    with pytest.raises(ValueError, match="MISSING_VAR_XYZ"):
        MCPClient.load_servers(
            {"bad": {"command": "${MISSING_VAR_XYZ}", "continue_on_error": False}}, continue_on_error=True
        )


def test_continue_on_error_server_key_false_overrides_default_for_client(mock_client, transports):
    MCPClient.load_servers({"srv": {"command": "node", "continue_on_error": False}}, continue_on_error=True)
    assert mock_client[0][1]["continue_on_error"] is False


def test_mixed_config_non_opted_in_failure_aborts_whole_load(mock_client, transports):
    """continue_on_error is per-server, not global: a failing server that did not opt in aborts the load.

    A sibling opting in does not extend its tolerance to others.
    """
    with pytest.raises(ValueError):
        MCPClient.load_servers(
            {
                "lenient": {"command": "node", "continue_on_error": True},
                "strict": {"command": "node", "env": {"V": "${NONEXISTENT_VAR}"}},
            }
        )


# OAuth Client Credentials (auth) Tests


def test_config_auth_builds_client_credentials_provider(mock_client, transports):
    with patch("mcp.client.auth.extensions.client_credentials.ClientCredentialsOAuthProvider") as provider_cls:
        MCPClient.load_servers(
            {
                "srv": {
                    "url": "https://example.com/mcp",
                    "auth": {"client_id": "id", "client_secret": "secret", "scopes": ["read", "write"]},
                }
            }
        )
    _open(mock_client[0][0])

    provider_cls.assert_called_once_with(
        server_url="https://example.com/mcp",
        storage=ANY,
        client_id="id",
        client_secret="secret",
        **{SCOPE_KWARG: "read write"},
    )
    assert transports["http"].call_args.kwargs["auth"] is provider_cls.return_value


def test_auth_interpolates_env_vars(mock_client, transports, monkeypatch):
    monkeypatch.setenv("OAUTH_ID", "env-id")
    monkeypatch.setenv("OAUTH_SECRET", "env-secret")
    with patch("mcp.client.auth.extensions.client_credentials.ClientCredentialsOAuthProvider") as provider_cls:
        MCPClient.load_servers(
            {
                "srv": {
                    "url": "https://example.com/mcp",
                    "auth": {"client_id": "${OAUTH_ID}", "client_secret": "${OAUTH_SECRET}"},
                }
            }
        )

    assert provider_cls.call_args.kwargs["client_id"] == "env-id"
    assert provider_cls.call_args.kwargs["client_secret"] == "env-secret"


def test_auth_with_sse_transport_raises(mock_client, transports):
    with pytest.raises(ValueError, match="'auth' for streamable-http transport only"):
        MCPClient.load_servers(
            {
                "srv": {
                    "url": "https://example.com/sse",
                    "transport": "sse",
                    "auth": {"client_id": "id", "client_secret": "secret"},
                }
            }
        )


def test_auth_with_stdio_transport_raises(mock_client, transports):
    with pytest.raises(ValueError, match="'auth' for streamable-http transport only"):
        MCPClient.load_servers({"srv": {"command": "node", "auth": {"client_id": "id", "client_secret": "secret"}}})


@pytest.mark.parametrize("auth", [{}, {"client_id": "id"}])
def test_auth_missing_required_keys_raises(mock_client, transports, auth):
    with pytest.raises(ValueError, match="missing required keys"):
        MCPClient.load_servers({"srv": {"url": "https://example.com/mcp", "auth": auth}})


@pytest.mark.parametrize("auth", ["not-a-dict", [], 0, ""])
def test_auth_non_dict_raises(mock_client, transports, auth):
    with pytest.raises(ValueError, match="'auth' must be an object"):
        MCPClient.load_servers({"srv": {"url": "https://example.com/mcp", "auth": auth}})


def test_auth_unknown_keys_warn(mock_client, transports, caplog):
    with caplog.at_level("WARNING", logger="strands.tools.mcp.mcp_client"):
        MCPClient.load_servers(
            {
                "srv": {
                    "url": "https://example.com/mcp",
                    "auth": {"client_id": "id", "client_secret": "secret", "unexpected": "value"},
                }
            }
        )
    assert "ignoring unrecognized auth keys" in caplog.text
