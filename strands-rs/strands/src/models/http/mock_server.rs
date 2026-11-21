//! A scripted HTTP/1.1 server on localhost for provider transport tests.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::retry::Sleeper;
use crate::types::JsonValue;

/// What the server does with the next request.
#[derive(Debug, Clone)]
pub(crate) enum MockResponse {
    /// Answers with a status, headers and body.
    Reply {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    },
    /// Closes the connection without answering.
    Drop,
    /// Keeps the connection open without answering.
    Hang,
}

impl MockResponse {
    pub(crate) fn status(status: u16, body: &str) -> Self {
        Self::Reply {
            status,
            headers: Vec::new(),
            body: body.to_owned(),
        }
    }

    pub(crate) fn json(status: u16, body: &JsonValue) -> Self {
        Self::Reply {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: body.to_string(),
        }
    }

    /// A `text/event-stream` reply with the named events.
    pub(crate) fn sse(events: &[(&str, JsonValue)]) -> Self {
        let body = events
            .iter()
            .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
            .collect();
        Self::Reply {
            status: 200,
            headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
            body,
        }
    }

    #[must_use]
    pub(crate) fn with_header(mut self, name: &str, value: &str) -> Self {
        if let Self::Reply { headers, .. } = &mut self {
            headers.push((name.to_owned(), value.to_owned()));
        }
        self
    }
}

/// A request the server received.
#[derive(Debug, Clone)]
pub(crate) struct RecordedRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    /// Header names lowercased, in arrival order.
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: String,
}

impl RecordedRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub(crate) fn json(&self) -> JsonValue {
        serde_json::from_str(&self.body).unwrap()
    }
}

pub(crate) struct MockServer {
    url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    /// Starts a server answering requests with `responses` in order, then with 404.
    pub(crate) async fn start(responses: Vec<MockResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            let mut responses = responses.into_iter();
            let mut held = Vec::new();
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let Some(request) = read_request(&mut socket).await else {
                    continue;
                };
                recorded.lock().unwrap().push(request);
                match responses.next() {
                    Some(MockResponse::Reply { status, headers, body }) => {
                        write_reply(&mut socket, status, &headers, &body).await;
                    }
                    Some(MockResponse::Drop) => drop(socket),
                    Some(MockResponse::Hang) => held.push(socket),
                    None => write_reply(&mut socket, 404, &[], "no scripted response").await,
                }
            }
        });
        Self { url, requests, task }
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    pub(crate) fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

async fn read_request(socket: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Some(RecordedRequest {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

async fn write_reply(socket: &mut TcpStream, status: u16, headers: &[(String, String)], body: &str) {
    let mut reply = format!(
        "HTTP/1.1 {status} Status\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        reply.push_str(&format!("{name}: {value}\r\n"));
    }
    reply.push_str("\r\n");
    reply.push_str(body);
    let _ = socket.write_all(reply.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Records the waits instead of sleeping.
#[derive(Default)]
pub(crate) struct RecordingSleeper(Mutex<Vec<Duration>>);

impl RecordingSleeper {
    pub(crate) fn delays(&self) -> Vec<Duration> {
        self.0.lock().unwrap().clone()
    }
}

#[async_trait]
impl Sleeper for RecordingSleeper {
    async fn sleep(&self, duration: Duration) {
        self.0.lock().unwrap().push(duration);
    }
}

/// Response head of a chunked server-sent event stream.
pub(crate) const SSE_CHUNKED_HEAD: &str =
    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";

/// Frames each piece as one chunk of a chunked body; `terminate` adds the final empty chunk, else
/// the body stays open.
pub(crate) fn chunked(pieces: &[&[u8]], terminate: bool) -> Vec<Vec<u8>> {
    let mut chunks: Vec<Vec<u8>> = pieces
        .iter()
        .map(|piece| {
            let mut chunk = format!("{:x}\r\n", piece.len()).into_bytes();
            chunk.extend_from_slice(piece);
            chunk.extend_from_slice(b"\r\n");
            chunk
        })
        .collect();
    if terminate {
        chunks.push(b"0\r\n\r\n".to_vec());
    }
    chunks
}

/// Serves one connection with raw bytes: reads the request, writes `head` and each piece in its
/// own write, then, with `hold`, keeps the socket open until the client closes it. The receiver
/// resolves when the client closes the connection.
pub(crate) async fn raw_server(
    head: &str,
    pieces: Vec<Vec<u8>>,
    hold: bool,
) -> (String, tokio::sync::oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (closed, on_close) = tokio::sync::oneshot::channel();
    let head = head.to_owned();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        if read_request(&mut socket).await.is_none() {
            return;
        }
        if socket.write_all(head.as_bytes()).await.is_err() {
            return;
        }
        for piece in pieces {
            if socket.write_all(&piece).await.is_err() {
                return;
            }
            let _ = socket.flush().await;
            tokio::task::yield_now().await;
        }
        if !hold {
            let _ = socket.shutdown().await;
            return;
        }
        let mut probe = [0u8; 64];
        loop {
            match socket.read(&mut probe).await {
                Ok(0) | Err(_) => {
                    let _ = closed.send(());
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    (url, on_close)
}
