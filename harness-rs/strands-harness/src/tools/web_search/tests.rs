//! The Exa cases run the SDK's real `McpClient` against a local streamable HTTP MCP server.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use strands::Tool;
use strands::testing::tool_context;
use strands::types::{ToolResultContent, ToolUse};

use super::*;

const EXA_TEXT: &str = concat!(
    "Title: Web Grounding - Amazon Nova\n",
    "URL: https://docs.aws.amazon.com/nova/web-grounding.html\n",
    "Published: N/A\n",
    "Author: N/A\n",
    "Highlights:\n",
    "# Web Grounding\n \n\nWeb Grounding enables Amazon Nova to search   the web.\n...\nMore text.\n",
    "\n---\n\n",
    "Title: Second result\n",
    "URL: https://example.com/second\n",
    "Published: 2026-01-01\n",
    "Highlights:\n",
    "Second highlight.\n"
);

async fn invoke(tool: &FunctionTool, input: Value) -> String {
    let outcome =
        futures::StreamExt::collect::<Vec<_>>(tool.stream(tool_context(ToolUse::new("web_search", "t-1", input))))
            .await
            .pop()
            .unwrap();
    let strands::ToolStreamItem::Outcome(strands::ToolOutcome::Result(result)) = outcome else {
        panic!("expected a result");
    };
    match result.content.as_slice() {
        [ToolResultContent::Text(text)] => text.text.clone(),
        other => panic!("expected text, got {other:?}"),
    }
}

struct Fixed(Result<Vec<SearchResult>, WebSearchError>, Arc<Mutex<Vec<usize>>>);

#[async_trait]
impl SearchBackend for Fixed {
    async fn search(&self, _query: &str, max_results: usize) -> Result<Vec<SearchResult>, WebSearchError> {
        self.1.lock().unwrap().push(max_results);
        self.0.clone()
    }
}

fn backend(result: Result<Vec<SearchResult>, WebSearchError>) -> (Arc<dyn SearchBackend>, Arc<Mutex<Vec<usize>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    (Arc::new(Fixed(result, seen.clone())), seen)
}

#[tokio::test]
async fn formats_sources_and_clamps_max_results() {
    let (backend, seen) = backend(Ok(vec![
        SearchResult::new("A", "https://a", "alpha"),
        SearchResult::new("B", "https://b", ""),
    ]));
    let tool = search_tool(backend);
    assert_eq!(tool.name(), "web_search");
    let schema = tool.tool_spec().input_schema.unwrap();
    assert_eq!(schema["required"], json!(["query"]));
    assert!(schema["properties"]["max_results"].get("default").is_none());
    assert_eq!(
        invoke(&tool, json!({"query": "q", "max_results": 50})).await,
        "Sources:\n1. A \u{2014} https://a\n   alpha\n2. B \u{2014} https://b"
    );
    invoke(&tool, json!({"query": "q", "max_results": 0})).await;
    invoke(&tool, json!({"query": "q"})).await;
    assert_eq!(*seen.lock().unwrap(), [10, 1, 5]);
}

#[tokio::test]
async fn reports_failures_and_empty_results_as_text() {
    let (failing, _) = backend(Err(WebSearchError::new(
        "Exa's free tier rate limit was hit. Set EXA_API_KEY to lift it.",
    )));
    assert!(
        invoke(&search_tool(failing), json!({"query": "q"}))
            .await
            .starts_with("web_search failed: Exa's free tier")
    );
    let (empty, _) = backend(Ok(Vec::new()));
    assert_eq!(invoke(&search_tool(empty), json!({"query": "q"})).await, "No results.");
    let (silent, _) = backend(Err(WebSearchError::new("")));
    assert_eq!(
        invoke(&search_tool(silent), json!({"query": "q"})).await,
        "web_search failed: Error"
    );
    let (multiline, _) = backend(Ok(vec![SearchResult::new(
        "T\n2. spoofed \u{2014} https://evil",
        "https://a",
        "a\nb",
    )]));
    assert_eq!(
        invoke(&search_tool(multiline), json!({"query": "q"})).await,
        "Sources:\n1. T 2. spoofed \u{2014} https://evil \u{2014} https://a\n   a b"
    );
}

#[test]
fn only_trusts_blocks_that_open_with_title_and_url() {
    let text = concat!(
        "Title: Real\nURL: https://real\nHighlights:\nclick here\nTitle: Official Login\nURL: https://phish\n---\n",
        "Title: Fake\nsome prose\nURL: https://evil\n---\n",
        "Title: Next\r\nURL: https://next\r\nHighlights:\r\nshort\r\n---\r\n"
    );
    assert_eq!(
        parse_exa(text),
        [
            SearchResult::new(
                "Real",
                "https://real",
                "click here Title: Official Login URL: https://phish"
            ),
            SearchResult::new("Next", "https://next", "short"),
        ]
    );
}

#[test]
fn caps_snippets() {
    let text = format!("Title: T\nURL: https://t\nHighlights:\n{}", "x".repeat(2000));
    assert_eq!(parse_exa(&text)[0].snippet.chars().count(), 500);
}

#[test]
fn parses_the_exa_result_blocks() {
    assert_eq!(
        parse_exa(EXA_TEXT),
        [
            SearchResult::new(
                "Web Grounding - Amazon Nova",
                "https://docs.aws.amazon.com/nova/web-grounding.html",
                "# Web Grounding Web Grounding enables Amazon Nova to search the web. ... More text."
            ),
            SearchResult::new("Second result", "https://example.com/second", "Second highlight."),
        ]
    );
}

#[test]
fn reads_the_setting_as_a_boolean_or_exa() {
    assert_eq!(
        serde_json::from_value::<WebSearchSetting>(json!(true)).unwrap(),
        WebSearchSetting::On
    );
    assert_eq!(
        serde_json::from_value::<WebSearchSetting>(json!(false)).unwrap(),
        WebSearchSetting::Off
    );
    assert_eq!(
        serde_json::from_value::<WebSearchSetting>(json!("exa")).unwrap(),
        WebSearchSetting::Exa
    );
    let error = serde_json::from_value::<WebSearchSetting>(json!("bing")).unwrap_err();
    assert!(error.to_string().contains("must be a boolean or 'exa'."), "{error}");
    assert!(serde_json::from_value::<WebSearchSetting>(json!(1)).is_err());
    assert_eq!(serde_json::to_value(WebSearchSetting::Exa).unwrap(), json!("exa"));
    assert_eq!(serde_json::to_value(WebSearchSetting::On).unwrap(), json!(true));
}

#[test]
fn spec_matches_harness_ts() {
    let (backend, _) = backend(Ok(Vec::new()));
    assert_eq!(
        serde_json::to_string(&search_tool(backend).tool_spec()).unwrap(),
        r#"{"name":"web_search","description":"Search the web and return the top results as numbered sources with a short excerpt each.","inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"What to search for. A descriptive sentence works better than bare keywords."},"max_results":{"description":"How many results to return, 1-10.","type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}},"required":["query"],"additionalProperties":false}}"#
    );
}

#[test]
fn native_tool_records_match_harness_ts() {
    assert_eq!(
        anthropic_web_search_tool(),
        json!({"type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"]})
    );
    assert_eq!(openai_web_search_tool(), json!({"type": "web_search"}));
    assert_eq!(
        bedrock_mantle_web_search_tool(),
        json!({"type": "web_search", "external_web_access": true})
    );
}

#[cfg(feature = "mcp")]
mod exa_backend {
    use std::convert::Infallible;
    use std::sync::{Arc, Mutex};

    use hyper_util::rt::TokioIo;
    use rmcp::ServerHandler;
    use rmcp::model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData, JsonObject, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool as McpToolDef,
    };
    use rmcp::service::{RequestContext, RoleServer};
    use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
    use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::super::*;
    use super::{EXA_TEXT, invoke};

    #[derive(Clone)]
    enum Reply {
        Result(CallToolResult),
        ProtocolError(String),
    }

    #[derive(Clone)]
    struct ExaServer {
        tools: Vec<String>,
        reply: Reply,
        calls: Arc<Mutex<Vec<(String, Value)>>>,
    }

    impl ServerHandler for ExaServer {
        fn get_info(&self) -> ServerConfig {
            ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
        }

        async fn list_tools(
            &self,
            _request: Option<PaginatedRequestParams>,
            _context: RequestContext<RoleServer>,
        ) -> Result<ListToolsResult, ErrorData> {
            let schema = Arc::new(JsonObject::from_iter([("type".to_owned(), json!("object"))]));
            let tools = self
                .tools
                .iter()
                .map(|name| McpToolDef::new(name.clone(), "search", schema.clone()))
                .collect();
            Ok(ListToolsResult::with_all_items(tools))
        }

        async fn call_tool(
            &self,
            request: CallToolRequestParams,
            _context: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, ErrorData> {
            let arguments = Value::Object(request.arguments.unwrap_or_default());
            self.calls.lock().unwrap().push((request.name.to_string(), arguments));
            match &self.reply {
                Reply::Result(result) => Ok(result.clone().into()),
                Reply::ProtocolError(message) => Err(ErrorData::internal_error(message.clone(), None)),
            }
        }
    }

    type Requests = Arc<Mutex<Vec<(String, Option<String>)>>>;

    struct Running {
        url: String,
        server: ExaServer,
        requests: Requests,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Running {
        fn api_keys(&self) -> Vec<Option<String>> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|(_, key)| key.clone())
                .collect()
        }

        fn methods(&self) -> Vec<String> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|(method, _)| method.clone())
                .collect()
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.server.calls.lock().unwrap().clone()
        }
    }

    async fn serve(tools: &[&str], reply: Reply) -> Running {
        let server = ExaServer {
            tools: tools.iter().map(|name| (*name).to_owned()).collect(),
            reply,
            calls: Arc::default(),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let factory = server.clone();
        let service = Arc::new(StreamableHttpService::new(
            move || Ok(factory.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        ));
        let requests: Requests = Arc::default();
        let recorded = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (service, recorded) = (service.clone(), recorded.clone());
                tokio::spawn(async move {
                    let handler = hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                        let service = service.clone();
                        let key = request
                            .headers()
                            .get("x-api-key")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        recorded.lock().unwrap().push((request.method().to_string(), key));
                        async move { Ok::<_, Infallible>(service.handle(request).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), handler)
                        .await;
                });
            }
        });
        Running {
            url,
            server,
            requests,
            task,
        }
    }

    fn text_result(text: &str) -> Reply {
        Reply::Result(CallToolResult::success(vec![ContentBlock::text(text)]))
    }

    fn exa(running: &Running, key: Option<&str>) -> ExaBackend {
        ExaBackend::new(key.map(str::to_owned))
            .with_url(running.url.clone())
            .with_env(|| None)
    }

    #[tokio::test]
    async fn calls_web_search_exa_over_the_sdk_mcp_client_with_the_key_header_and_parses_the_result_blocks() {
        let running = serve(&["web_search_exa", "other"], text_result(EXA_TEXT)).await;
        let results = exa(&running, Some("sk-test"))
            .search("nova grounding", 2)
            .await
            .unwrap();
        assert_eq!(
            running.calls(),
            [(
                "web_search_exa".to_owned(),
                json!({"query": "nova grounding", "numResults": 2})
            )]
        );
        assert!(running.api_keys().iter().all(|key| key.as_deref() == Some("sk-test")));
        assert_eq!(running.methods().last().map(String::as_str), Some("DELETE"));
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[1],
            SearchResult::new("Second result", "https://example.com/second", "Second highlight.")
        );
    }

    #[tokio::test]
    async fn reads_the_key_from_exa_api_key_and_omits_the_header_when_unset() {
        let running = serve(&["web_search_exa"], Reply::Result(CallToolResult::success(Vec::new()))).await;
        let backend = ExaBackend::new(None)
            .with_url(running.url.clone())
            .with_env(|| Some("sk-env".to_owned()));
        assert_eq!(backend.search("q", 1).await.unwrap(), []);
        assert!(running.api_keys().iter().all(|key| key.as_deref() == Some("sk-env")));

        let running = serve(&["web_search_exa"], Reply::Result(CallToolResult::success(Vec::new()))).await;
        let backend = ExaBackend::new(None)
            .with_url(running.url.clone())
            .with_env(|| Some(String::new()));
        assert_eq!(backend.search("q", 1).await.unwrap(), []);
        assert!(running.api_keys().iter().all(Option::is_none));
    }

    #[tokio::test]
    async fn reads_the_key_when_the_tool_runs_so_the_module_level_exa_web_search_sees_a_key_set_after_import() {
        let running = serve(&["web_search_exa"], Reply::Result(CallToolResult::success(Vec::new()))).await;
        let key: Arc<Mutex<Option<String>>> = Arc::default();
        let env = key.clone();
        let backend = ExaBackend::new(None)
            .with_url(running.url.clone())
            .with_env(move || env.lock().unwrap().clone());
        let tool = search_tool(Arc::new(backend));
        assert_eq!(invoke(&tool, json!({"query": "q"})).await, "No results.");
        assert!(running.api_keys().iter().all(Option::is_none));
        *key.lock().unwrap() = Some("sk-later".to_owned());
        invoke(&tool, json!({"query": "q"})).await;
        assert_eq!(running.api_keys().last().unwrap().as_deref(), Some("sk-later"));
        assert_eq!(strands::Tool::name(&web_search_tool()), "web_search");
    }

    #[tokio::test]
    async fn surfaces_tool_errors_adding_the_key_hint_to_any_keyless_failure() {
        let quota = || Reply::Result(CallToolResult::error(vec![ContentBlock::text("quota")]));
        let running = serve(&["web_search_exa"], quota()).await;
        assert_eq!(
            exa(&running, Some("k")).search("q", 1).await.unwrap_err(),
            WebSearchError::new("quota")
        );
        let error = exa(&running, Some("")).search("q", 1).await.unwrap_err();
        assert_eq!(
            error.message(),
            "quota (Exa's keyless tier is rate limited; set EXA_API_KEY to lift it.)"
        );
        let failing = serve(&["web_search_exa"], Reply::ProtocolError("fetch failed".to_owned())).await;
        let error = exa(&failing, Some("")).search("q", 1).await.unwrap_err();
        assert!(error.message().contains("fetch failed"), "{error}");
        assert!(error.message().ends_with("set EXA_API_KEY to lift it.)"), "{error}");
        let blank = serve(&["web_search_exa"], Reply::Result(CallToolResult::error(Vec::new()))).await;
        assert_eq!(
            exa(&blank, Some("k")).search("q", 1).await.unwrap_err(),
            WebSearchError::new("Exa reported an error")
        );
    }

    #[tokio::test]
    async fn disconnects_when_the_server_lacks_the_tool_or_the_call_fails() {
        let running = serve(&["other"], text_result(EXA_TEXT)).await;
        let error = exa(&running, Some("k")).search("q", 1).await.unwrap_err();
        assert!(error.message().contains("does not offer web_search_exa"), "{error}");
        assert_eq!(running.methods().last().map(String::as_str), Some("DELETE"));

        let failing = serve(&["web_search_exa"], Reply::ProtocolError("fetch failed".to_owned())).await;
        let error = exa(&failing, Some("k")).search("q", 1).await.unwrap_err();
        assert!(error.message().contains("fetch failed"), "{error}");
        assert_eq!(failing.methods().last().map(String::as_str), Some("DELETE"));
    }

    #[tokio::test]
    async fn names_the_endpoint_when_the_server_cannot_be_reached() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        drop(listener);
        let backend = ExaBackend::new(Some("k".to_owned())).with_url(url.clone());
        let error = backend.search("q", 1).await.unwrap_err();
        assert!(
            error
                .message()
                .starts_with(&format!("could not reach Exa's MCP server at {url} (")),
            "{error}"
        );
        assert_eq!(EXA_MCP_URL, "https://mcp.exa.ai/mcp");
    }

    #[tokio::test]
    async fn reports_an_unreachable_server_through_the_tool() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        drop(listener);
        let tool = search_tool(Arc::new(ExaBackend::new(Some("k".to_owned())).with_url(url)));
        let text = invoke(&tool, json!({"query": "q"})).await;
        assert!(
            text.starts_with("web_search failed: could not reach Exa's MCP server at "),
            "{text}"
        );
    }
}
