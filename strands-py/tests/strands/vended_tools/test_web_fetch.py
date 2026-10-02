"""Tests for the web_fetch tool."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import httpx
import pytest
from bs4 import BeautifulSoup

import strands.agent.agent as agent_module
from strands.sandbox.types import ExecutionResult
from strands.types.tools import ToolContext, ToolUse
from strands.vended_tools.web_fetch import (
    WebFetchError,
    make_web_fetch,
)
from strands.vended_tools.web_fetch import _extract as extract_module
from strands.vended_tools.web_fetch._extract import _tag_attribute, html_to_markdown
from strands.vended_tools.web_fetch.web_fetch import _curl_command, _parse_charset, _validate_url


def _transport(handler):
    """Build a mock httpx transport from a request handler callable."""
    return httpx.MockTransport(handler)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=_transport(handler))


def _make_ctx(cancel: threading.Event | None = None) -> ToolContext:
    cancel = cancel or threading.Event()
    agent = SimpleNamespace(model=None, _cancel_signal=cancel)
    tool_use = ToolUse(toolUseId="test-wf", name="web_fetch", input={})
    return ToolContext(tool_use=tool_use, agent=agent, invocation_state={}, cancel_signal=cancel)


def _raising_beautiful_soup(*args, **kwargs):
    raise ValueError("mock extraction failure")


class _MockSandbox:
    """Minimal sandbox mock for curl-transport tests."""

    def __init__(self, *, stdout="", stderr="", exit_code=0, file_data=b""):
        self._stdout = stdout
        self._stderr = stderr
        self._exit_code = exit_code
        self._file_data = file_data
        self.commands: list[str] = []

    async def execute(self, command, **kwargs):
        self.commands.append(command)
        if command.startswith("rm "):
            return ExecutionResult(exit_code=0, stdout="", stderr="")
        return ExecutionResult(exit_code=self._exit_code, stdout=self._stdout, stderr=self._stderr)

    async def read_file(self, path, **kwargs):
        return self._file_data


def _sandbox_ctx(sandbox, **kwargs):
    cancel = kwargs.pop("cancel", None) or threading.Event()
    agent = SimpleNamespace(model=None, _cancel_signal=cancel, sandbox=sandbox, **kwargs)
    tool_use = ToolUse(toolUseId="test-wf", name="web_fetch", input={})
    return ToolContext(tool_use=tool_use, agent=agent, invocation_state={}, cancel_signal=cancel)


class TestLazyLoad:
    """web_fetch and make_web_fetch are lazy-loaded via __getattr__."""

    def test_make_web_fetch_accessible_from_vended_tools(self):
        import strands.vended_tools as vt

        assert vt.make_web_fetch is make_web_fetch

    def test_unknown_attribute_raises(self):
        import strands.vended_tools as vt

        with pytest.raises(AttributeError):
            _ = vt.not_a_real_tool


class TestWebFetchToolCall:
    """End-to-end tool behavior with the transport stubbed out."""

    @pytest.mark.asyncio
    async def test_html_response_returns_markdown(self):
        html = "<html><head><title>T</title></head><body><h1>Hi</h1></body></html>"

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=html)

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/")
        assert "# T" in tru_result
        assert "# Hi" in tru_result

    @pytest.mark.asyncio
    async def test_non_html_response_returns_body(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="plain text response")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/robots.txt")
        assert tru_result == "plain text response"

    @pytest.mark.asyncio
    async def test_xml_content_type_is_converted_to_markdown(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "application/xhtml+xml"},
                text="<html><body><p>xhtml</p></body></html>",
            )

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/page.xhtml")
        assert "xhtml" in tru_result

    @pytest.mark.asyncio
    async def test_markdown_content_is_truncated(self):
        # max_content_chars limits what the main agent receives, with a marker.
        body = "x" * 200

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text=body)

        tool = make_web_fetch(client=_client(handler), mode="markdown", max_content_chars=50)
        tru_result = await tool(url="https://example.com/")
        assert tru_result.startswith("x" * 50)
        assert "[content truncated]" in tru_result

    @pytest.mark.asyncio
    async def test_rejects_non_http_scheme(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.InvalidURL("unsupported scheme")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await tool(url="file:///etc/passwd")

    @pytest.mark.asyncio
    async def test_transport_error_is_wrapped_as_value_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await tool(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_body_over_cap_is_rejected(self):
        big = b"x" * 100

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, content=big)

        tool = make_web_fetch(client=_client(handler), max_bytes=50, mode="markdown")
        with pytest.raises(WebFetchError, match="exceeded"):
            await tool(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_error_status_raises(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="Not Found")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="HTTP 404"):
            await tool(url="https://example.com/missing")

    @pytest.mark.asyncio
    async def test_user_client_redirect_behaviour_is_respected(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/old":
                return httpx.Response(
                    301, headers={"location": "https://example.com/new", "content-type": "text/plain"}, text="moved"
                )
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="new page")

        # User-supplied client with follow_redirects=False: redirect is not followed.
        client = httpx.AsyncClient(transport=_transport(handler), follow_redirects=False)
        tool = make_web_fetch(client=client, mode="markdown")
        tru_result = await tool(url="https://example.com/old")
        assert tru_result == "moved"

    @pytest.mark.asyncio
    async def test_timeout_is_wrapped_as_web_fetch_error(self):
        async def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        tool = make_web_fetch(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), mode="markdown")
        with pytest.raises(WebFetchError, match="timed out"):
            await tool(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_html_extraction_failure_falls_back_to_raw(self, monkeypatch):
        # html_to_markdown falls back to raw input on parser failure,
        # so the model always receives readable content.
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>raw content</p>")

        monkeypatch.setattr(extract_module, "BeautifulSoup", _raising_beautiful_soup)
        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/")
        assert tru_result == "<p>raw content</p>"

    @pytest.mark.asyncio
    async def test_sends_correct_headers(self):
        received: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            received.update(request.headers)
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="ok")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        await tool(url="https://example.com/")
        assert "strands-agents-web-fetch" in received.get("user-agent", "")

    @pytest.mark.asyncio
    async def test_pre_flight_cancel_short_circuits(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("transport should not be called if cancel is pre-set")

        cancel = threading.Event()
        cancel.set()
        ctx = _make_ctx(cancel)

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(asyncio.CancelledError):
            await tool(url="https://example.com/", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_mid_flight_cancel_aborts_between_chunks(self):
        cancel = threading.Event()

        def handler(_request: httpx.Request) -> httpx.Response:
            async def body():
                yield b"chunk-one"
                cancel.set()  # signal mid-stream
                yield b"chunk-two"

            return httpx.Response(200, headers={"content-type": "text/plain"}, content=body())

        ctx = _make_ctx(cancel)

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(asyncio.CancelledError):
            await tool(url="https://example.com/", tool_context=ctx)


class TestAnalyst:
    """Analyst agent is called when model + prompt are both provided."""

    def _page_client(self, body: str = "<p>page content</p>") -> httpx.AsyncClient:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

        return _client(handler)

    @pytest.mark.asyncio
    async def test_agentic_content_is_truncated_before_analyst(self, monkeypatch):
        # max_content_chars limits what the analyst receives.
        body = "x" * 200

        def page_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text=body)

        received_prompt: list[str] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_prompt.append(prompt)
                return "answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(
            client=_client(page_handler),
            model=SimpleNamespace(),
            mode="agentic",
            max_content_chars=50,
        )
        await tool(url="https://example.com/", prompt="Summarize")
        assert "x" * 50 in received_prompt[0]
        assert "x" * 51 not in received_prompt[0]
        assert "[content truncated]" in received_prompt[0]

    @pytest.mark.asyncio
    async def test_prompt_without_model_and_no_agent_raises(self):
        # No factory model and no host agent — agentic mode has nowhere to go.
        tool = make_web_fetch(client=self._page_client(), mode="agentic")
        with pytest.raises(WebFetchError, match="agentic mode requires a model"):
            await tool(url="https://example.com/", prompt="What is this about?")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "host_agent_attrs",
        [
            {"aux_model": SimpleNamespace(), "model": SimpleNamespace()},
            {"model": SimpleNamespace()},
        ],
        ids=["aux_model", "model_only"],
    )
    async def test_prompt_uses_host_agent_aux_model_when_no_factory_model(self, monkeypatch, host_agent_attrs):
        # When no factory model is set, the host agent's aux_model is used, or its model when
        # the host has no aux_model attribute.
        received_model: list = []

        class _FakeAgent:
            def __init__(self, model=None, **kwargs):
                received_model.append(model)

            async def invoke_async(self, prompt: str, **kwargs):
                return "host answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool_use = ToolUse(toolUseId="wf_2", name="web_fetch", input={})
        host_agent = SimpleNamespace(_cancel_signal=None, **host_agent_attrs)
        ctx = ToolContext(tool_use=tool_use, agent=host_agent, invocation_state={})

        tool = make_web_fetch(client=self._page_client(), mode="agentic")
        tru_result = await tool(url="https://example.com/", prompt="Summarize", tool_context=ctx)
        assert tru_result == "host answer"
        exp_model = host_agent_attrs.get("aux_model", host_agent_attrs["model"])
        assert received_model[0] is exp_model

    @pytest.mark.asyncio
    async def test_empty_prompt_with_model_returns_markdown(self, monkeypatch):
        # markdown mode skips the analyst regardless of model configuration.
        fake_model = SimpleNamespace()
        invoked: list[bool] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                invoked.append(True)
                return "answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(client=self._page_client(), model=fake_model, mode="markdown")
        tru_result = await tool(url="https://example.com/")
        assert not invoked
        assert "page content" in tru_result

    @pytest.mark.parametrize("prompt", ["", "   "])
    @pytest.mark.asyncio
    async def test_agentic_mode_with_empty_prompt_raises(self, prompt):
        tool = make_web_fetch(client=self._page_client(), model=SimpleNamespace(), mode="agentic")
        with pytest.raises(WebFetchError, match="agentic mode requires a non-empty prompt"):
            await tool(url="https://example.com/", prompt=prompt)

    @pytest.mark.asyncio
    async def test_prompt_with_model_invokes_analyst(self, monkeypatch):
        fake_model = SimpleNamespace()
        received_prompt: list[str] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_prompt.append(prompt)
                return "the answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(client=self._page_client(), model=fake_model, mode="agentic")
        tru_result = await tool(url="https://example.com/", prompt="What is this about?")
        assert tru_result == "the answer"
        assert len(received_prompt) == 1
        assert "What is this about?" in received_prompt[0]
        assert "page content" in received_prompt[0]


class TestParseCharset:
    """_parse_charset extracts charset from Content-Type values, defaulting to utf-8."""

    def test_plain_charset(self):
        assert _parse_charset("text/html; charset=utf-8") == "utf-8"

    def test_quoted_charset(self):
        assert _parse_charset('text/html; charset="iso-8859-1"') == "iso-8859-1"

    def test_missing_charset_defaults_to_utf8(self):
        assert _parse_charset("text/plain") == "utf-8"

    def test_empty_charset_defaults_to_utf8(self):
        assert _parse_charset("text/html; charset=") == "utf-8"


class TestHtmlToMarkdown:
    """Extraction strips noise and preserves structure."""

    def test_strips_script_and_style(self):
        html = """
        <html><head><title>Hi</title>
        <style>body{color:red}</style>
        </head><body>
        <p>Hello world.</p>
        <script>alert('xss')</script>
        <p>After script.</p>
        </body></html>
        """
        md = html_to_markdown(html)
        assert "# Hi" in md
        assert "alert" not in md
        assert "color:red" not in md
        assert "Hello world." in md
        assert "After script." in md

    def test_strips_data_uri_images(self):
        blob = "A" * 200
        html = f'<p>text</p><img src="data:image/png;base64,{blob}" alt="alt text">'
        md = html_to_markdown(html)
        assert blob not in md
        assert "data:" not in md
        assert "alt text" in md

    def test_preserves_regular_images(self):
        html = '<img src="https://example.com/pic.png" alt="pic">'
        md = html_to_markdown(html)
        assert "![pic](https://example.com/pic.png)" in md

    def test_javascript_href_is_dropped(self):
        html = '<a href="javascript:alert(1)">click</a>'
        md = html_to_markdown(html)
        assert "javascript:" not in md
        assert "click" in md

    def test_javascript_img_src_is_dropped(self):
        html = '<img src="javascript:alert(1)" alt="x">'
        md = html_to_markdown(html)
        assert "javascript:" not in md

    @pytest.mark.parametrize("prefix", [" ", "\u200b", "\ufeff"])
    def test_javascript_img_src_with_invisible_prefix_is_dropped(self, prefix):
        html = f'<img src="{prefix}javascript:alert(1)" alt="x">'
        md = html_to_markdown(html)
        assert "javascript:" not in md

    @pytest.mark.parametrize("prefix", [" ", "\t", "\u200b", "\ufeff", "\u00ad"])
    def test_javascript_href_with_invisible_prefix_is_dropped(self, prefix):
        # Invisible/whitespace prefixes before "javascript:" must not bypass the check.
        html = f'<a href="{prefix}javascript:alert(1)">click</a>'
        md = html_to_markdown(html)
        assert "javascript:" not in md
        assert "click" in md

    def test_preserves_headings_lists_and_links(self):
        html = """
        <h1>Title</h1>
        <p>Intro paragraph with a <a href="https://ex.com/x">link</a>.</p>
        <ul><li>one</li><li>two</li></ul>
        <ol><li>first</li><li>second</li></ol>
        """
        md = html_to_markdown(html)
        assert "# Title" in md
        assert "[link](https://ex.com/x)" in md
        assert "- one" in md
        assert "- two" in md
        assert "1. first" in md
        assert "2. second" in md

    def test_preserves_code_blocks(self):
        html = "<pre><code>def f():\n    return 1</code></pre>"
        md = html_to_markdown(html)
        assert "```" in md
        assert "def f():" in md
        assert "return 1" in md

    def test_returns_input_on_parser_exception(self, monkeypatch):
        monkeypatch.setattr(extract_module, "BeautifulSoup", _raising_beautiful_soup)
        assert html_to_markdown("<p>anything</p>") == "<p>anything</p>"


def test__tag_attribute_joins_list_values():
    # BS4 returns ``class`` as a list; _tag_attribute must join it.
    tag = BeautifulSoup('<div class="foo bar">', "html.parser").div
    assert _tag_attribute(tag, "class") == "foo bar"


# ---- Curl transport & URL validation ----


class TestValidateUrl:
    """_validate_url rejects anything that isn't a safe http(s) URL."""

    @pytest.mark.parametrize(
        "url",
        [
            "https://example.com/page",
            "http://example.com/",
            "https://example.com/a%20b",
            "https://example.com/p?q=1&r=2#frag",
        ],
    )
    def test_accepts_valid_url(self, url):
        assert _validate_url(url) == url

    def test_strips_whitespace(self):
        assert _validate_url("  https://example.com/ ") == "https://example.com/"

    @pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://ftp.example.com/pub"])
    def test_rejects_non_http_scheme(self, url):
        with pytest.raises(WebFetchError, match="only supports http"):
            _validate_url(url)

    @pytest.mark.parametrize(
        "url",
        [
            "https://example.com/has space",
            "https://example.com/a|b",
            "https://example.com/`id`",
        ],
    )
    def test_rejects_non_rfc3986_url(self, url):
        with pytest.raises(WebFetchError, match="RFC 3986"):
            _validate_url(url)

    def test_rejects_no_host(self):
        with pytest.raises(WebFetchError, match="no host"):
            _validate_url("https://")


class TestCurlTransport:
    """End-to-end tool behaviour with the sandbox stubbed out."""

    def _tool(self, **kwargs):
        return make_web_fetch(client="curl", mode="markdown", **kwargs)

    @pytest.mark.asyncio
    async def test_html_response_returns_markdown(self):
        html = "<html><head><title>T</title></head><body><h1>Hi</h1></body></html>"
        sandbox = _MockSandbox(
            stdout="text/html; charset=utf-8\nhttps://example.com/\n",
            file_data=html.encode(),
        )
        result = await self._tool()(url="https://example.com/", tool_context=_sandbox_ctx(sandbox))
        assert "# T" in result
        assert "# Hi" in result

    @pytest.mark.asyncio
    async def test_plain_text_and_charset_decoding(self):
        sandbox = _MockSandbox(
            stdout="text/plain; charset=iso-8859-1\nhttps://example.com/\n",
            file_data="café".encode("iso-8859-1"),
        )
        result = await self._tool()(url="https://example.com/", tool_context=_sandbox_ctx(sandbox))
        assert "café" in result

    @pytest.mark.asyncio
    async def test_curl_error_raises(self):
        sandbox = _MockSandbox(exit_code=22, stderr="curl: (22) The requested URL returned error: 404")
        with pytest.raises(WebFetchError, match="404"):
            await self._tool()(url="https://example.com/missing", tool_context=_sandbox_ctx(sandbox))

    @pytest.mark.asyncio
    async def test_truncation(self):
        sandbox = _MockSandbox(stdout="text/plain\nhttps://example.com/\n", file_data=b"x" * 200)
        result = await self._tool(max_content_chars=50)(
            url="https://example.com/",
            tool_context=_sandbox_ctx(sandbox),
        )
        assert result.startswith("x" * 50)
        assert "[content truncated]" in result

    @pytest.mark.asyncio
    async def test_url_validation_rejects_bad_urls(self):
        sandbox = _MockSandbox()
        ctx = _sandbox_ctx(sandbox)
        with pytest.raises(WebFetchError, match="only supports http"):
            await self._tool()(url="file:///etc/passwd", tool_context=ctx)
        with pytest.raises(WebFetchError, match="RFC 3986"):
            await self._tool()(url="https://example.com/a|b", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_no_sandbox_raises(self):
        ctx = _make_ctx()
        with pytest.raises(WebFetchError, match="requires a sandbox"):
            await self._tool()(url="https://example.com/", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_no_tool_context_raises(self):
        with pytest.raises(WebFetchError, match="requires a sandbox"):
            await self._tool()(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_cleanup_runs_on_success_and_failure(self):
        # Success path
        sandbox = _MockSandbox(stdout="text/plain\nhttps://example.com/\n", file_data=b"ok")
        await self._tool()(url="https://example.com/", tool_context=_sandbox_ctx(sandbox))
        assert len(sandbox.commands) == 2
        assert sandbox.commands[1].startswith("rm -f")

        # Failure path
        sandbox = _MockSandbox(exit_code=6, stderr="Could not resolve host")
        with pytest.raises(WebFetchError):
            await self._tool()(url="https://example.com/", tool_context=_sandbox_ctx(sandbox))
        assert any(cmd.startswith("rm -f") for cmd in sandbox.commands)


def test_curl_command_shape():
    cmd = _curl_command("https://example.com/", "/tmp/out", max_bytes=42)
    assert "https://example.com/" in cmd
    assert "head -c 42" in cmd
    assert "--proto '=http,https'" in cmd
    assert "--proto-redir '=http,https'" in cmd
    assert "--fail" in cmd


def test_make_web_fetch_rejects_invalid_client():
    with pytest.raises(ValueError, match="client must be"):
        make_web_fetch(client="wget")  # type: ignore[arg-type]
