"""Tests for the web_fetch tool."""

from __future__ import annotations

import asyncio
import socket
import threading
from types import SimpleNamespace

import httpx
import pytest
from bs4 import BeautifulSoup

import strands.agent.agent as agent_module
from strands.agent.invocation_context import _create_invocation_context, _reached_limit
from strands.types.tools import ToolContext, ToolUse
from strands.vended_tools.web_fetch import (
    WebFetchError,
    make_web_fetch,
)
from strands.vended_tools.web_fetch import _extract as extract_module
from strands.vended_tools.web_fetch._address_guard import is_public_address
from strands.vended_tools.web_fetch._extract import _tag_attribute, html_to_markdown
from strands.vended_tools.web_fetch.web_fetch import _parse_charset


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


@pytest.fixture(autouse=True)
def dns(monkeypatch):
    """Resolve hostnames from the returned mapping instead of the network; unmapped names are public."""
    hosts: dict[str, list[str]] = {}
    real_getaddrinfo = socket.getaddrinfo

    def getaddrinfo(host, port, *args, **kwargs):
        try:
            return real_getaddrinfo(host, port, flags=socket.AI_NUMERICHOST)
        except socket.gaierror:
            pass
        addresses = hosts.get(host, ["93.184.216.34"])
        if not addresses:
            raise socket.gaierror(socket.EAI_NONAME, "Name or service not known")
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (address, 0)) for address in addresses]

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    return hosts


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
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await make_web_fetch(mode="markdown")(url="file:///etc/passwd")

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


class TestNonPublicAddresses:
    """Hosts that are, or resolve to, non-public addresses are refused unless allowed."""

    @staticmethod
    def _recording_client(requests: list[str], redirects: dict[str, str] | None = None, **kwargs) -> httpx.AsyncClient:
        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(str(request.url))
            location = (redirects or {}).get(str(request.url))
            if location is not None:
                return httpx.Response(302, headers={"location": location})
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="secret")

        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)

    @pytest.mark.parametrize(
        ("address", "expected"),
        [
            ("0.0.0.0", False),
            ("10.0.0.5", False),
            ("100.64.0.1", False),
            ("127.0.0.1", False),
            ("127.255.255.254", False),
            ("169.254.169.254", False),
            ("172.16.0.1", False),
            ("172.31.255.255", False),
            ("192.0.0.192", False),
            ("192.168.1.1", False),
            ("198.18.0.1", False),
            ("224.0.0.1", False),
            ("255.255.255.255", False),
            ("::", False),
            ("::1", False),
            ("::ffff:127.0.0.1", False),
            ("::ffff:a00:5", False),
            ("fc00::1", False),
            ("fd00:ec2::254", False),
            ("fe80::1", False),
            ("fe80::1%eth0", False),
            ("fec0::1", False),
            ("ff02::1", False),
            ("8.8.8.8", True),
            ("172.15.255.255", True),
            ("172.32.0.1", True),
            ("::ffff:8.8.8.8", True),
            ("2606:4700:4700::1111", True),
        ],
    )
    def test_is_public_address(self, address, expected):
        assert is_public_address(address) is expected

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:8080/",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/",
            "http://0.0.0.0/",
            "http://2130706433/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fe80::1]/",
            "https://[fd00:ec2::254]/",
        ],
    )
    @pytest.mark.asyncio
    async def test_refuses_literal_address_without_sending_a_request(self, url):
        requests: list[str] = []
        tool = make_web_fetch(client=self._recording_client(requests), mode="markdown")

        with pytest.raises(WebFetchError, match="^Fetch refused"):
            await tool(url=url)
        assert requests == []

    @pytest.mark.parametrize("addresses", [["10.0.0.5"], ["::1"], ["93.184.216.34", "169.254.169.254"]])
    @pytest.mark.asyncio
    async def test_refuses_hostname_resolving_to_a_non_public_address(self, dns, addresses):
        dns["internal.example"] = addresses
        requests: list[str] = []
        tool = make_web_fetch(client=self._recording_client(requests), mode="markdown")

        with pytest.raises(WebFetchError, match="^Fetch refused: 'internal.example'"):
            await tool(url="https://internal.example/")
        assert requests == []

    @pytest.mark.asyncio
    async def test_refuses_hostname_that_does_not_resolve(self, dns):
        dns["unknown.example"] = []
        requests: list[str] = []
        tool = make_web_fetch(client=self._recording_client(requests), mode="markdown")

        with pytest.raises(WebFetchError, match="^Fetch failed: could not resolve host 'unknown.example'"):
            await tool(url="https://unknown.example/")
        assert requests == []

    @pytest.mark.asyncio
    async def test_refuses_redirect_to_a_non_public_address(self):
        requests: list[str] = []
        redirects = {"https://example.com/": "http://127.0.0.1:8080/admin"}
        client = self._recording_client(requests, redirects, follow_redirects=True)

        with pytest.raises(WebFetchError, match="^Fetch refused: '127.0.0.1'"):
            await make_web_fetch(client=client, mode="markdown")(url="https://example.com/")
        assert requests == ["https://example.com/"]

    @pytest.mark.asyncio
    async def test_refuses_redirect_to_a_hostname_resolving_to_a_non_public_address(self, dns):
        dns["internal.example"] = ["10.0.0.5"]
        requests: list[str] = []
        redirects = {"https://example.com/": "/hop", "https://example.com/hop": "https://internal.example/"}
        client = self._recording_client(requests, redirects, follow_redirects=True)

        with pytest.raises(WebFetchError, match="^Fetch refused: 'internal.example'"):
            await make_web_fetch(client=client, mode="markdown")(url="https://example.com/")
        assert requests == ["https://example.com/", "https://example.com/hop"]

    @pytest.mark.asyncio
    async def test_follows_redirects_to_public_hosts(self):
        requests: list[str] = []
        redirects = {"https://example.com/old": "/new"}
        client = self._recording_client(requests, redirects, follow_redirects=True)

        tru_result = await make_web_fetch(client=client, mode="markdown")(url="https://example.com/old")

        assert tru_result == "secret"
        assert requests == ["https://example.com/old", "https://example.com/new"]

    @pytest.mark.asyncio
    async def test_client_auth_is_not_sent_to_another_origin_on_redirect(self):
        authorization: dict[str, str | None] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            authorization[request.url.host] = request.headers.get("authorization")
            if request.url.host == "example.com":
                return httpx.Response(302, headers={"location": "https://other.example/"})
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="ok")

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=True, auth=("user", "password")
        )

        await make_web_fetch(client=client, mode="markdown")(url="https://example.com/")

        assert authorization["example.com"] is not None
        assert authorization["other.example"] is None

    @pytest.mark.asyncio
    async def test_does_not_follow_redirects_when_the_client_does_not(self):
        requests: list[str] = []
        redirects = {"https://example.com/": "https://example.com/next"}
        client = self._recording_client(requests, redirects)

        await make_web_fetch(client=client, mode="markdown")(url="https://example.com/")

        assert requests == ["https://example.com/"]

    @pytest.mark.asyncio
    async def test_stops_after_the_client_redirect_limit(self):
        requests: list[str] = []
        redirects = {"https://example.com/loop": "https://example.com/loop"}
        client = self._recording_client(requests, redirects, follow_redirects=True, max_redirects=3)

        with pytest.raises(WebFetchError, match="too many redirects"):
            await make_web_fetch(client=client, mode="markdown")(url="https://example.com/loop")
        assert len(requests) == 4

    @pytest.mark.asyncio
    async def test_allow_private_addresses_fetches_through_a_redirect(self, dns):
        dns["internal.example"] = ["10.0.0.5"]
        requests: list[str] = []
        redirects = {"https://internal.example/": "http://127.0.0.1:8080/admin"}
        client = self._recording_client(requests, redirects, follow_redirects=True)
        tool = make_web_fetch(client=client, mode="markdown", allow_private_addresses=True)

        tru_result = await tool(url="https://internal.example/")

        assert tru_result == "secret"
        assert requests == ["https://internal.example/", "http://127.0.0.1:8080/admin"]


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


class TestWebFetchRequestUsage:
    """The analyst joins the request the tool call belongs to."""

    @staticmethod
    def _page_client() -> httpx.AsyncClient:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>page content</p>")

        return _client(handler)

    @pytest.mark.asyncio
    async def test_analyst_joins_the_request_the_tool_call_belongs_to(self, monkeypatch):
        received_kwargs: list[dict] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_kwargs.append(kwargs)
                return "the answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(client=self._page_client(), model=SimpleNamespace(), mode="agentic")
        request = _create_invocation_context({"turns": 1})
        request._usage["turns_taken"] = 1
        tool_use = {"toolUseId": "1", "name": "web_fetch", "input": {}}
        ctx = ToolContext(tool_use=tool_use, agent=SimpleNamespace(), invocation_state={}, invocation_context=request)

        await tool(url="https://example.com/", prompt="What is this about?", tool_context=ctx)

        handed = received_kwargs[0]["invocation_context"]
        handed._record_usage({"inputTokens": 1, "outputTokens": 2, "totalTokens": 3})
        assert _reached_limit(handed) is None
        assert request.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 2, "totalTokens": 3}
