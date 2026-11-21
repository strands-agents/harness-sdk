//! In-order delivery of `notifications/progress` to the callback of the tool call they belong to.
//!
//! `rmcp` runs each notification handler on its own task, so handler-side delivery can reorder
//! updates. The connection's transport is wrapped instead: a call's callback is registered when
//! its request goes out, and every progress notification is queued as it is read, for one task
//! that runs the callbacks in arrival order. A call flushes the queue before it returns.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rmcp::RoleClient;
use rmcp::model::{
    ClientJsonRpcMessage, ClientRequest, GetExtensions, ProgressToken, RequestMetaObject, ServerJsonRpcMessage,
    ServerNotification,
};
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use tokio::sync::{mpsc, oneshot};

use super::callbacks::{McpProgress, McpProgressCallback};
use super::transport::{BoxedTransport, TransportError};

/// Marks a `tools/call` request whose progress goes to this callback.
#[derive(Clone)]
pub(crate) struct ProgressRoute(pub(crate) McpProgressCallback);

enum Dispatch {
    Progress(McpProgressCallback, McpProgress),
    Flush(oneshot::Sender<()>),
}

/// The progress routes of one connection.
pub(crate) struct ProgressRouter {
    routes: Mutex<HashMap<ProgressToken, McpProgressCallback>>,
    queue: mpsc::UnboundedSender<Dispatch>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn dispatch(client: String, mut queue: mpsc::UnboundedReceiver<Dispatch>) {
    while let Some(item) = queue.recv().await {
        match item {
            Dispatch::Progress(callback, progress) => {
                if let Err(error) = callback.call(progress).await {
                    tracing::warn!("client=<{client}>, error=<{error}> | progress callback failed");
                }
            }
            Dispatch::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}

fn request_progress_token(item: &ClientJsonRpcMessage) -> Option<(ProgressToken, McpProgressCallback)> {
    let ClientJsonRpcMessage::Request(request) = item else {
        return None;
    };
    let ClientRequest::CallToolRequest(call) = &request.request else {
        return None;
    };
    let route = call.extensions().get::<ProgressRoute>()?;
    let token = call
        .extensions()
        .get::<RequestMetaObject>()
        .and_then(RequestMetaObject::get_progress_token)
        .or_else(|| {
            call.params
                .meta
                .as_ref()
                .and_then(RequestMetaObject::get_progress_token)
        })?;
    Some((token, route.0.clone()))
}

impl ProgressRouter {
    /// A router whose callbacks run on a task that ends with the connection.
    pub(crate) fn new(client: String) -> Arc<Self> {
        let (queue, receiver) = mpsc::unbounded_channel();
        tokio::spawn(dispatch(client, receiver));
        Arc::new(Self {
            routes: Mutex::new(HashMap::new()),
            queue,
        })
    }

    fn on_send(&self, item: &ClientJsonRpcMessage) {
        if let Some((token, callback)) = request_progress_token(item) {
            lock(&self.routes).insert(token, callback);
        }
    }

    fn on_receive(&self, item: &ServerJsonRpcMessage) {
        let ServerJsonRpcMessage::Notification(notification) = item else {
            return;
        };
        let ServerNotification::ProgressNotification(progress) = &notification.notification else {
            return;
        };
        let params = &progress.params;
        let Some(callback) = lock(&self.routes).get(&params.progress_token).cloned() else {
            return;
        };
        let update = McpProgress::new(params.progress, params.total, params.message.clone());
        let _ = self.queue.send(Dispatch::Progress(callback, update));
    }

    /// Stops routing progress for `token`.
    pub(crate) fn remove(&self, token: &ProgressToken) {
        lock(&self.routes).remove(token);
    }

    /// Waits until every progress update read so far has been delivered.
    pub(crate) async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self.queue.send(Dispatch::Flush(done)).is_ok() {
            let _ = wait.await;
        }
    }
}

/// A connection's transport, routing progress through its [`ProgressRouter`].
pub(crate) struct RoutedTransport {
    transport: BoxedTransport,
    router: Arc<ProgressRouter>,
}

impl RoutedTransport {
    pub(crate) fn new(transport: BoxedTransport, router: Arc<ProgressRouter>) -> Self {
        Self { transport, router }
    }
}

impl Transport<RoleClient> for RoutedTransport {
    type Error = TransportError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.router.on_send(&item);
        self.transport.send(item)
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleClient>> {
        let item = self.transport.receive().await?;
        self.router.on_receive(&item);
        Some(item)
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.transport.close()
    }
}
