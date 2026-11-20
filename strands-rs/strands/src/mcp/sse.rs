//! The legacy HTTP+SSE client transport (`SSEClientTransport`): a GET event stream that announces
//! the message endpoint in an `endpoint` event, and a POST per outgoing message. `rmcp` ships no
//! client for this protocol revision (2024-11-05).
//!
//! As a browser `EventSource` does, the stream reopens after it ends or fails, after the server's
//! `retry` delay (3 s by default) and with `Last-Event-ID`; a non-success status on reopening
//! closes the transport, and an `endpoint` event on the new stream replaces the message endpoint.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use eventsource_stream::{Event, Eventsource};
use futures::StreamExt;
use futures::future::BoxFuture;
use reqwest::Url;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use rmcp::RoleClient;
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::error::McpError;
use super::transport::{BoxedTransport, McpTransport};

const DEFAULT_RETRY: Duration = Duration::from_secs(3);
const LAST_EVENT_ID: HeaderName = HeaderName::from_static("last-event-id");
const PROTOCOL_VERSION: HeaderName = HeaderName::from_static("mcp-protocol-version");

/// A legacy SSE transport failure.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct SseTransportError(String);

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What the stream reader and the sender share: the current message endpoint and the protocol
/// version the server chose in `initialize`.
#[derive(Default)]
struct Shared {
    endpoint: Mutex<Option<Url>>,
    protocol_version: Mutex<Option<HeaderValue>>,
}

impl Shared {
    fn endpoint(&self) -> Option<Url> {
        self.endpoint.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set_endpoint(&self, endpoint: Url) {
        *self.endpoint.lock().unwrap_or_else(PoisonError::into_inner) = Some(endpoint);
    }

    /// The configured headers plus `mcp-protocol-version` once negotiated.
    fn headers(&self, configured: &HeaderMap) -> HeaderMap {
        let mut headers = configured.clone();
        let version = self
            .protocol_version
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(version) = version {
            headers.insert(PROTOCOL_VERSION, version);
        }
        headers
    }

    fn note_protocol_version(&self, data: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        let result = &value["result"];
        let Some(version) = result["protocolVersion"].as_str() else {
            return;
        };
        if !result["capabilities"].is_object() {
            return;
        }
        if let Ok(version) = HeaderValue::from_str(version) {
            *self.protocol_version.lock().unwrap_or_else(PoisonError::into_inner) = Some(version);
        }
    }
}

struct SseClientTransport {
    client: reqwest::Client,
    headers: HeaderMap,
    shared: Arc<Shared>,
    messages: mpsc::UnboundedReceiver<RxJsonRpcMessage<RoleClient>>,
    _reader: AbortOnDrop,
}

impl Transport<RoleClient> for SseClientTransport {
    type Error = SseTransportError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let request = self.shared.endpoint().map(|endpoint| {
            self.client
                .post(endpoint)
                .headers(self.shared.headers(&self.headers))
                .header(CONTENT_TYPE, "application/json")
                .json(&item)
        });
        async move {
            let Some(request) = request else {
                return Err(SseTransportError("Not connected".to_owned()));
            };
            let response = request
                .send()
                .await
                .map_err(|error| SseTransportError(error.to_string()))?;
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if status.is_success() {
                return Ok(());
            }
            Err(SseTransportError(format!(
                "Error POSTing to endpoint (HTTP {}): {text}",
                status.as_u16()
            )))
        }
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.messages.recv()
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self._reader.0.abort();
        self.messages.close();
        Ok(())
    }
}

fn header_map(headers: &BTreeMap<String, String>) -> Result<HeaderMap, McpError> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let header = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| McpError::other(format!("Invalid header name \"{name}\": {error}")))?;
        let value = HeaderValue::from_str(value)
            .map_err(|error| McpError::other(format!("Invalid header value for \"{name}\": {error}")))?;
        map.insert(header, value);
    }
    Ok(map)
}

fn resolve_endpoint(base: &Url, data: &str) -> Result<Url, McpError> {
    let endpoint = base
        .join(data)
        .map_err(|error| McpError::other(format!("Invalid endpoint URL \"{data}\": {error}")))?;
    if endpoint.origin() != base.origin() {
        return Err(McpError::other(format!(
            "Endpoint origin does not match connection origin: {}",
            endpoint.origin().ascii_serialization()
        )));
    }
    Ok(endpoint)
}

fn parse_message(data: &str) -> Option<RxJsonRpcMessage<RoleClient>> {
    match serde_json::from_str(data) {
        Ok(message) => Some(message),
        Err(error) => {
            tracing::warn!("error=<{error}> | failed to parse mcp sse message");
            None
        }
    }
}

/// Whether the reader goes on after an event or a stream.
enum Flow {
    Continue,
    Stop,
}

/// Why the event stream did not open.
enum OpenError {
    Status(u16),
    Network(String),
}

impl From<OpenError> for McpError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::Status(status) => McpError::transport(format!("SSE error: Non-200 status code ({status})")),
            OpenError::Network(error) => McpError::transport(format!("SSE error: {error}")),
        }
    }
}

/// The reconnection state an `EventSource` keeps across streams.
struct Resume {
    last_event_id: Option<String>,
    retry: Duration,
}

/// Reads the event stream, reopening it as an `EventSource` does, until the transport closes.
struct Reader {
    client: reqwest::Client,
    url: Url,
    headers: HeaderMap,
    shared: Arc<Shared>,
    messages: mpsc::UnboundedSender<RxJsonRpcMessage<RoleClient>>,
    endpoint: Option<oneshot::Sender<Result<Url, McpError>>>,
    resume: Resume,
}

impl Reader {
    async fn open(&self) -> Result<reqwest::Response, OpenError> {
        let mut request = self
            .client
            .get(self.url.clone())
            .headers(self.shared.headers(&self.headers))
            .header(ACCEPT, "text/event-stream");
        if let Some(id) = &self.resume.last_event_id {
            request = request.header(LAST_EVENT_ID, id.as_str());
        }
        let response = request
            .send()
            .await
            .map_err(|error| OpenError::Network(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(OpenError::Status(status.as_u16()));
        }
        Ok(response)
    }

    async fn run(mut self, mut response: reqwest::Response) {
        loop {
            if let Flow::Stop = self.read(response).await {
                return;
            }
            if let Some(sender) = self.endpoint.take() {
                let _ = sender.send(Err(McpError::transport(
                    "SSE error: stream ended before the endpoint event",
                )));
                return;
            }
            let Some(next) = self.reopen().await else {
                return;
            };
            response = next;
        }
    }

    async fn reopen(&self) -> Option<reqwest::Response> {
        loop {
            tokio::time::sleep(self.resume.retry).await;
            if self.messages.is_closed() {
                return None;
            }
            match self.open().await {
                Ok(response) => return Some(response),
                Err(OpenError::Status(status)) => {
                    tracing::warn!("status=<{status}> | mcp sse stream reopen rejected, closing the transport");
                    return None;
                }
                Err(OpenError::Network(error)) => {
                    tracing::warn!("error=<{error}> | mcp sse stream reopen failed, retrying");
                }
            }
        }
    }

    async fn read(&mut self, response: reqwest::Response) -> Flow {
        let mut events = response.bytes_stream().eventsource();
        while let Some(event) = events.next().await {
            let event = match event {
                Ok(event) => event,
                Err(error) => {
                    tracing::warn!("error=<{error}> | mcp sse stream failed");
                    return Flow::Continue;
                }
            };
            if let Flow::Stop = self.handle(&event) {
                return Flow::Stop;
            }
        }
        Flow::Continue
    }

    fn handle(&mut self, event: &Event) -> Flow {
        if let Some(retry) = event.retry {
            self.resume.retry = retry;
        }
        if !event.id.is_empty() {
            self.resume.last_event_id = Some(event.id.clone());
        }
        if event.event == "endpoint" {
            return self.handle_endpoint(&event.data);
        }
        if !(event.event.is_empty() || event.event == "message") {
            return Flow::Continue;
        }
        self.shared.note_protocol_version(&event.data);
        let Some(message) = parse_message(&event.data) else {
            return Flow::Continue;
        };
        if self.messages.send(message).is_err() {
            return Flow::Stop;
        }
        Flow::Continue
    }

    fn handle_endpoint(&mut self, data: &str) -> Flow {
        let resolved = resolve_endpoint(&self.url, data);
        if let Ok(endpoint) = &resolved {
            self.shared.set_endpoint(endpoint.clone());
        }
        let failed = resolved.is_err();
        match self.endpoint.take() {
            Some(sender) => {
                let _ = sender.send(resolved);
            }
            None => {
                if let Err(error) = &resolved {
                    tracing::warn!("error=<{error}> | invalid mcp sse endpoint, closing the transport");
                }
            }
        }
        if failed { Flow::Stop } else { Flow::Continue }
    }
}

async fn start(url: Url, headers: HeaderMap) -> Result<BoxedTransport, McpError> {
    let client = reqwest::Client::new();
    let shared = Arc::new(Shared::default());
    let (endpoint_tx, endpoint_rx) = oneshot::channel();
    let (messages_tx, messages_rx) = mpsc::unbounded_channel();
    let reader = Reader {
        client: client.clone(),
        url,
        headers: headers.clone(),
        shared: shared.clone(),
        messages: messages_tx,
        endpoint: Some(endpoint_tx),
        resume: Resume {
            last_event_id: None,
            retry: DEFAULT_RETRY,
        },
    };
    let response = reader.open().await?;
    let reader = AbortOnDrop(tokio::spawn(reader.run(response)));
    endpoint_rx
        .await
        .map_err(|_| McpError::transport("SSE error: stream ended before the endpoint event"))??;
    Ok(BoxedTransport::new(SseClientTransport {
        client,
        headers,
        shared,
        messages: messages_rx,
        _reader: reader,
    }))
}

impl McpTransport {
    /// Connects over the legacy HTTP+SSE protocol (`SSEClientTransport`): `url` serves the event
    /// stream, and `headers` go on every request.
    ///
    /// ```
    /// use strands::mcp::McpTransport;
    ///
    /// let transport = McpTransport::sse("http://localhost:8000/sse", None)?;
    /// # Ok::<(), strands::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// An invalid URL, header name or header value.
    pub fn sse(url: &str, headers: Option<BTreeMap<String, String>>) -> crate::Result<Self> {
        let url = Url::parse(url).map_err(|error| McpError::other(format!("Invalid URL \"{url}\": {error}")))?;
        let headers = header_map(&headers.unwrap_or_default())?;
        let factory = Arc::new(move || -> BoxFuture<'static, Result<BoxedTransport, McpError>> {
            Box::pin(start(url.clone(), headers.clone()))
        });
        Ok(Self::from_factory("sse", factory))
    }
}

/// Unit tests for the endpoint rules of the legacy SSE transport.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_a_relative_endpoint_against_the_stream_url() {
        let base = Url::parse("http://127.0.0.1:9000/sse").unwrap();
        let endpoint = resolve_endpoint(&base, "/messages?sessionId=abc").unwrap();
        assert_eq!(endpoint.as_str(), "http://127.0.0.1:9000/messages?sessionId=abc");
    }

    #[test]
    fn rejects_an_endpoint_on_another_origin() {
        let base = Url::parse("http://127.0.0.1:9000/sse").unwrap();
        let error = resolve_endpoint(&base, "http://evil.example/messages").unwrap_err();
        assert_eq!(
            error.to_string(),
            "Endpoint origin does not match connection origin: http://evil.example"
        );
    }
}
