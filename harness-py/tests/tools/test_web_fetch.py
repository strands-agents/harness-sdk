import re
import shlex
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest
from strands.models import BedrockModel, ModelRouter
from strands.sandbox import ExecutionResult
from strands.sandbox.errors import SandboxTimeoutError
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment

from strands_harness import create_harness
from strands_harness.models import resolve_web_fetch_model
from strands_harness.tools import make_web_fetch
from strands_harness.tools import web_fetch as web_fetch_module


def test_html_to_text_strips_tags_and_scripts():
    html = "<html><body><script>x=1</script><style>.a{}</style><p>Hello  <b>world</b></p></body></html>"
    assert web_fetch_module._html_to_text(html) == "Hello world"


class _Sandbox:
    """Fake sandbox: curl "writes" ``body`` to the requested file and reports ``content_type``/``url``."""

    def __init__(self, body=b"", content_type="text/html", url="https://example.com/final", stderr="", exit_code=0):
        self.body = body
        self.result = ExecutionResult(exit_code=exit_code, stdout=f"{content_type}\n{url}\n", stderr=stderr)
        self.commands = []
        self.files = {}

    async def execute(self, command, **kwargs):
        self.commands.append(command)
        if command.startswith("rm -f "):
            for path in shlex.split(command)[2:]:
                self.files.pop(path, None)
            return ExecutionResult(exit_code=0, stdout="", stderr="")
        if self.result.exit_code == 0:
            self.files[re.search(r"-o (\S+)", command).group(1).strip("'")] = self.body
        return self.result

    async def read_file(self, path):
        return self.files[path]

    @property
    def curl(self):
        return next(c for c in self.commands if c.startswith("curl "))


def _context(sandbox):
    return SimpleNamespace(agent=SimpleNamespace(sandbox=sandbox))


async def test_fetch_text_rejects_non_http_scheme():
    sandbox = _Sandbox()
    with pytest.raises(ValueError, match="only supports http"):
        await web_fetch_module._fetch_text(sandbox, "ftp://example.com/file", "curl")
    assert sandbox.commands == []


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/a b",
        "https://example.com/x`id`",
        'https://example.com/"x"',
        "https://example.com/x\nrm -rf /",
        "https://example.com/{a,b}",
        "https://example.com/日本",
        "https:///no-host",
        "javascript:alert(1)",
        "",
    ],
)
async def test_fetch_text_rejects_malformed_urls_before_touching_the_sandbox(url):
    sandbox = _Sandbox()
    with pytest.raises(ValueError):
        await web_fetch_module._fetch_text(sandbox, url, "curl")
    assert sandbox.commands == []


def test_validate_url_accepts_rfc3986_urls_and_strips_whitespace():
    assert web_fetch_module._validate_url(" https://e.com/a?b=c&d=%20#f ") == "https://e.com/a?b=c&d=%20#f"
    assert web_fetch_module._validate_url("http://[::1]:8080/x") == "http://[::1]:8080/x"


async def test_fetch_text_direct_transport_skips_the_sandbox(monkeypatch):
    calls = []

    class Response:
        headers = {"Content-Type": "text/html; charset=utf-8"}
        body = b"<p>Hi <b>there</b></p>"

        def read1(self, n):
            chunk, self.body = self.body[:n], self.body[n:]
            return chunk

        def geturl(self):
            return "https://example.com/final"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    class Opener:
        def open(self, request, timeout):
            calls.append((request.full_url, request.get_header("User-agent"), timeout))
            return Response()

    monkeypatch.setattr(web_fetch_module, "build_opener", lambda *handlers: Opener())
    sandbox = _Sandbox()
    assert await web_fetch_module._fetch_text(sandbox, "https://example.com", "direct") == (
        "https://example.com/final",
        "Hi there",
    )
    assert sandbox.commands == []
    assert calls == [("https://example.com", web_fetch_module._USER_AGENT, web_fetch_module._TIMEOUT)]


async def test_fetch_text_direct_transport_pins_redirects_to_http_and_bounds_the_download(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/ftp":
                self.send_response(302)
                self.send_header("Location", "ftp://127.0.0.1:2121/x")
                self.end_headers()
                return
            if self.path == "/drip":
                self.send_response(200)
                self.send_header("Content-Length", "100")
                self.end_headers()
                for _ in range(100):
                    try:
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.2)
                    except OSError:
                        return
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"page")

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        assert await web_fetch_module._fetch_text(_Sandbox(), f"{base}/page", "direct") == (f"{base}/page", "page")
        # urllib's default handler would follow this hop to ftp://; every hop is held to the URL rules.
        with pytest.raises(ValueError, match="only supports http"):
            await web_fetch_module._fetch_text(_Sandbox(), f"{base}/ftp", "direct")
        # The per-read socket timeout would let a slow drip run for minutes; the deadline is wall-clock.
        monkeypatch.setattr(web_fetch_module, "_TIMEOUT", 1)
        started = time.monotonic()
        with pytest.raises(TimeoutError, match="gave up"):
            await web_fetch_module._fetch_text(_Sandbox(), f"{base}/drip", "direct")
        assert time.monotonic() - started < 5
    finally:
        server.shutdown()


def test_make_web_fetch_rejects_an_unknown_transport():
    with pytest.raises(ValueError, match="transport"):
        make_web_fetch(model=object(), transport="wget")


async def test_fetch_text_runs_curl_in_the_sandbox_and_reads_the_final_hop():
    sandbox = _Sandbox(body=b"<p>Hi <b>there</b></p>")
    resolved, text = await web_fetch_module._fetch_text(sandbox, "https://example.com/a'b$(id);c", "curl")
    assert (resolved, text) == ("https://example.com/final", "Hi there")
    command = sandbox.curl
    # Legal URL characters that mean something to a shell arrive single-quoted.
    assert "'https://example.com/a'\"'\"'b$(id);c'" in command
    for flag in (
        "-g",
        "--fail",
        "--proto '=http,https'",
        "--proto-redir '=http,https'",
        "--max-time",
        "-o ",
        "%{content_type}",
        "%{url_effective}",
        " -- '",
    ):
        assert flag in command
    # The body file is removed afterwards.
    assert sandbox.commands[-1].startswith("rm -f ") and sandbox.files == {}


async def test_fetch_text_handles_a_missing_content_type():
    # curl prints an empty content-type line; the URL must not slide into its slot.
    sandbox = _Sandbox(body=b"a < b <i>", content_type="", url="https://example.com/report.html")
    resolved, text = await web_fetch_module._fetch_text(sandbox, "https://example.com", "curl")
    assert (resolved, text) == ("https://example.com/report.html", "a < b <i>")


async def test_fetch_text_truncates_the_body_in_the_sandbox():
    command = web_fetch_module._curl_command("https://example.com", "/tmp/f")
    assert f"&& head -c {web_fetch_module._MAX_BYTES} /tmp/f > /tmp/f.part && mv -f /tmp/f.part /tmp/f" in command
    assert "--max-filesize" not in command


async def test_fetch_text_keeps_non_html_verbatim():
    sandbox = _Sandbox(body=b"raw <b>text</b>", content_type="text/plain")
    _, text = await web_fetch_module._fetch_text(sandbox, "https://example.com", "curl")
    assert text == "raw <b>text</b>"


async def test_fetch_text_honours_the_response_charset():
    sandbox = _Sandbox(body="日本語".encode("shift_jis"), content_type="text/plain; charset='Shift_JIS'")
    _, text = await web_fetch_module._fetch_text(sandbox, "https://example.com", "curl")
    assert text == "日本語"


async def test_fetch_text_falls_back_to_utf8_for_an_unknown_charset():
    sandbox = _Sandbox(body="é".encode(), content_type="text/plain; charset=not-a-codec")
    _, text = await web_fetch_module._fetch_text(sandbox, "https://example.com", "curl")
    assert text == "é"


async def test_fetch_text_surfaces_curl_errors_and_still_cleans_up():
    sandbox = _Sandbox(stderr="curl: (22) The requested URL returned error: 404\n", exit_code=22)
    with pytest.raises(RuntimeError, match=r"\(22\).*404"):
        await web_fetch_module._fetch_text(sandbox, "https://example.com/missing", "curl")
    assert sandbox.commands[-1].startswith("rm -f ")


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl not installed")
async def test_fetch_text_end_to_end_through_the_local_environment():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/page")
                self.end_headers()
                return
            if self.path == "/huge":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(6 * 1024 * 1024))
                self.end_headers()
                self.wfile.write(b"x" * (6 * 1024 * 1024))
                return
            if self.path == "/notype":
                self.send_response(200)
                self.send_header("Content-Length", "5")
                self.end_headers()
                self.wfile.write(b"a < b")
                return
            if self.path == "/big":
                # Well past the sandbox's 64 KiB read chunks: multi-byte characters must survive intact.
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(("日" * 100_000).encode())
                return
            self.send_response(404 if self.path == "/missing" else 200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<html><body><script>x</script><p>Hello <b>wörld</b></p></body></html>".encode())

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    sandbox = NotASandboxLocalEnvironment()
    try:
        assert await web_fetch_module._fetch_text(sandbox, f"{base}/redirect", "curl") == (
            f"{base}/page",
            "Hello wörld",
        )
        _, big = await web_fetch_module._fetch_text(sandbox, f"{base}/big", "curl")
        assert big == "日" * web_fetch_module._MAX_CHARS
        _, huge = await web_fetch_module._fetch_text(sandbox, f"{base}/huge", "curl")
        assert huge == "x" * web_fetch_module._MAX_CHARS
        assert await web_fetch_module._fetch_text(sandbox, f"{base}/notype", "curl") == (f"{base}/notype", "a < b")
        assert (await sandbox.execute("ls /tmp | grep -c strands-web-fetch")).stdout.strip() == "0"
        with pytest.raises(RuntimeError, match="404"):
            await web_fetch_module._fetch_text(sandbox, f"{base}/missing", "curl")
    finally:
        server.shutdown()


async def test_web_fetch_returns_summarizer_answer(monkeypatch):
    async def fake_fetch(sandbox, url, transport):
        return url, "The sky is blue because of Rayleigh scattering."

    monkeypatch.setattr(web_fetch_module, "_fetch_text", fake_fetch)

    captured = {}

    class FakeAgent:
        def __init__(self, **kwargs):
            captured["model"] = kwargs.get("model")

        async def invoke_async(self, prompt):
            captured["prompt"] = prompt
            return "Rayleigh scattering."

    monkeypatch.setattr(web_fetch_module, "Agent", FakeAgent)

    sentinel = object()
    tool = make_web_fetch(model=sentinel)
    answer = await tool._tool_func(
        url="https://example.com", prompt="Why is the sky blue?", tool_context=_context(_Sandbox())
    )

    assert answer == "Rayleigh scattering."
    assert captured["model"] is sentinel
    assert "Why is the sky blue?" in captured["prompt"]
    assert "Rayleigh scattering" in captured["prompt"]


async def test_web_fetch_uses_the_agents_sandbox():
    sandbox = _Sandbox(body=b"page", content_type="text/plain")
    tool = make_web_fetch(model=object())
    assert await tool._tool_func(url="https://example.com", tool_context=_context(sandbox)) == "page"
    assert sandbox.curl


async def test_web_fetch_returns_raw_content_without_prompt(monkeypatch):
    async def fake_fetch(sandbox, url, transport):
        return url, "The whole page content."

    monkeypatch.setattr(web_fetch_module, "_fetch_text", fake_fetch)

    def fail_agent(**kwargs):
        raise AssertionError("summarizer should not run without a prompt")

    monkeypatch.setattr(web_fetch_module, "Agent", fail_agent)

    tool = make_web_fetch(model=object())
    context = _context(_Sandbox())
    answer = await tool._tool_func(url="https://example.com", tool_context=context)
    assert answer == "The whole page content."

    answer = await tool._tool_func(url="https://example.com", prompt="   ", tool_context=context)
    assert answer == "The whole page content."


@pytest.mark.parametrize(
    "error",
    [RuntimeError("curl: (6) Could not resolve host"), SandboxTimeoutError("slow"), ConnectionError("sandbox gone")],
)
async def test_web_fetch_reports_fetch_failure(monkeypatch, error):
    async def boom(sandbox, url, transport):
        raise error

    monkeypatch.setattr(web_fetch_module, "_fetch_text", boom)
    tool = make_web_fetch(model=object())

    answer = await tool._tool_func(url="https://example.com", prompt="anything", tool_context=_context(_Sandbox()))
    assert answer.startswith("Failed to fetch https://example.com")
    assert str(error) in answer


async def test_web_fetch_caches_within_ttl(monkeypatch):
    calls = {"n": 0}

    async def counting_fetch(sandbox, url, transport):
        calls["n"] += 1
        return url, "content"

    monkeypatch.setattr(web_fetch_module, "_fetch_text", counting_fetch)

    class FakeAgent:
        def __init__(self, **kwargs):
            pass

        async def invoke_async(self, prompt):
            return "ok"

    monkeypatch.setattr(web_fetch_module, "Agent", FakeAgent)

    tool = make_web_fetch(model=object())
    context = _context(_Sandbox())
    await tool._tool_func(url="https://example.com", prompt="first", tool_context=context)
    await tool._tool_func(url="https://example.com", prompt="second", tool_context=context)
    assert calls["n"] == 1


def test_resolve_web_fetch_model_defaults_to_provider_small_model():
    model = resolve_web_fetch_model("bedrock/global.anthropic.claude-opus-4-8", None)
    assert isinstance(model, BedrockModel)
    assert model.get_config()["model_id"] == "global.anthropic.claude-haiku-4-5-20251001-v1:0"


def test_resolve_web_fetch_model_uses_openai_small_model_for_openai_on_bedrock():
    model = resolve_web_fetch_model("bedrock/openai.gpt-5.6-luna", None)
    assert isinstance(model, BedrockModel)
    assert model.get_config()["model_id"] == "openai.gpt-5.6-luna"


def test_resolve_web_fetch_model_keeps_cross_region_prefix_for_openai_on_bedrock():
    model = resolve_web_fetch_model("bedrock/us.openai.gpt-5.6-sol", None)
    assert model.get_config()["model_id"] == "us.openai.gpt-5.6-luna"


def test_resolve_web_fetch_model_keeps_global_prefix_for_openai_on_bedrock():
    model = resolve_web_fetch_model("bedrock/global.openai.gpt-5.6-sol", None)
    assert model.get_config()["model_id"] == "global.openai.gpt-5.6-luna"


def test_resolve_web_fetch_model_keeps_haiku_for_anthropic_on_bedrock():
    model = resolve_web_fetch_model("bedrock/global.anthropic.claude-opus-4-8", None)
    assert model.get_config()["model_id"] == "global.anthropic.claude-haiku-4-5-20251001-v1:0"


def test_resolve_web_fetch_model_reuses_main_model_for_unknown_bedrock_family(caplog):
    with caplog.at_level("WARNING"):
        model = resolve_web_fetch_model("bedrock/amazon.nova-pro-v1:0", None)
    assert isinstance(model, BedrockModel)
    assert model.get_config()["model_id"] == "amazon.nova-pro-v1:0"
    assert "could not identify the Bedrock model family" in caplog.text


def test_resolve_web_fetch_model_no_warning_with_explicit_override_for_unknown_bedrock(caplog):
    override = BedrockModel(model_id="explicit")
    with caplog.at_level("WARNING"):
        assert resolve_web_fetch_model("bedrock/amazon.nova-pro-v1:0", override) is override
    assert "could not identify the Bedrock model family" not in caplog.text


def test_resolve_web_fetch_model_reuses_main_model_instance():
    main = BedrockModel(model_id="whatever")
    assert resolve_web_fetch_model(main, None) is main


def test_resolve_web_fetch_model_uses_router_default():
    default = BedrockModel(model_id="fast")
    router = ModelRouter([default, BedrockModel(model_id="deep")])
    assert resolve_web_fetch_model(router, None) is default


def test_resolve_web_fetch_model_uses_explicit_router_default():
    default = BedrockModel(model_id="fast")
    router = ModelRouter([default, BedrockModel(model_id="deep")])
    assert resolve_web_fetch_model(None, router) is default


def test_resolve_web_fetch_model_uses_explicit_override():
    override = BedrockModel(model_id="explicit")
    assert resolve_web_fetch_model("bedrock/global.anthropic.claude-opus-4-8", override) is override


def test_resolve_web_fetch_model_has_a_default_for_bedrock_mantle():
    model = resolve_web_fetch_model("bedrock-mantle/openai.gpt-oss-120b", None)
    assert model.get_config()["model_id"] == "openai.gpt-5.6-luna"


def test_web_fetch_transport_is_curl_by_default_and_configurable(monkeypatch):
    seen = []
    real = web_fetch_module.make_web_fetch

    def spy(*, model, **kwargs):
        seen.append(kwargs)
        return real(model=model, **kwargs)

    monkeypatch.setattr("strands_harness.agent.make_web_fetch", spy)
    create_harness()
    create_harness(builtin_tools={"web_fetch": {"transport": "direct"}})
    assert seen == [{}, {"transport": "direct"}]


def test_web_fetch_rejects_an_unknown_transport_setting():
    with pytest.raises(ValueError, match="transport"):
        create_harness(builtin_tools={"web_fetch": {"transport": "wget"}})


def test_web_fetch_enabled_by_default():
    agent = create_harness()
    assert "web_fetch" in agent.tool_registry.registry


def test_web_fetch_absent_when_not_selected():
    agent = create_harness(builtin_tools=["read"])
    assert "web_fetch" not in agent.tool_registry.registry


def test_summarizer_reuses_the_main_model_on_a_repointed_anthropic_endpoint(monkeypatch, caplog):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1")
    with caplog.at_level("WARNING"):
        model = resolve_web_fetch_model("anthropic/anthropic.claude-fable-5", None)
    assert model.get_config()["model_id"] == "anthropic.claude-fable-5"
    assert "non-default endpoint" in caplog.text


def test_summarizer_reuses_the_main_model_on_a_repointed_openai_endpoint(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://bedrock-mantle.us-west-2.api.aws/v1")
    model = resolve_web_fetch_model("openai/gpt-oss-20b", None)
    assert model.get_config()["model_id"] == "gpt-oss-20b"


def test_summarizer_still_uses_the_small_model_on_the_first_party_endpoint(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    model = resolve_web_fetch_model("anthropic/claude-opus-4-5-20251101", None)
    assert model.get_config()["model_id"] == "claude-haiku-4-5-20251001"


def test_a_repointed_endpoint_does_not_affect_bedrock(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://example.invalid/anthropic")
    model = resolve_web_fetch_model("bedrock/global.anthropic.claude-opus-4-8", None)
    assert model.get_config()["model_id"] == "global.anthropic.claude-haiku-4-5-20251001-v1:0"
