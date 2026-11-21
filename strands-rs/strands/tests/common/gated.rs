//! Tools the test drives step by step, so concurrency is deterministic without timers.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::json;
use strands::tools::{ToolStream, ToolStreamEvent, ToolStreamItem};
use strands::types::{ToolResultContent, ToolSpec};
use strands::{JsonValue, Tool, ToolContext, ToolResultBlock};
use tokio::sync::{mpsc, oneshot, watch};

struct GateState {
    started: watch::Sender<bool>,
    released: watch::Sender<bool>,
    cancelled: AtomicBool,
    completed: AtomicBool,
}

/// A tool that waits until [`release`](Self::release) or until its cancel signal fires. Clones
/// share the gate and the observations.
#[derive(Clone)]
pub struct GatedTool {
    name: String,
    state: Arc<GateState>,
}

impl GatedTool {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            state: Arc::new(GateState {
                started: watch::Sender::new(false),
                released: watch::Sender::new(false),
                cancelled: AtomicBool::new(false),
                completed: AtomicBool::new(false),
            }),
        }
    }

    /// Opens the gate, for this and every later call.
    pub fn release(&self) {
        self.state.released.send_replace(true);
    }

    /// Completes once the tool has entered its stream.
    pub async fn started(&self) {
        let mut started = self.state.started.subscribe();
        let _ = started.wait_for(|started| *started).await;
    }

    pub fn has_started(&self) -> bool {
        *self.state.started.borrow()
    }

    pub fn was_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    pub fn has_completed(&self) -> bool {
        self.state.completed.load(Ordering::SeqCst)
    }
}

impl Tool for GatedTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Gated tool"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new(&self.name, "Gated tool").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let state = self.state.clone();
        let name = self.name.clone();
        ToolStream::from_future(async move {
            state.started.send_replace(true);
            let mut released = state.released.subscribe();
            tokio::select! {
                _ = released.wait_for(|released| *released) => {}
                () = context.cancel_signal().cancelled() => state.cancelled.store(true, Ordering::SeqCst),
            }
            state.completed.store(true, Ordering::SeqCst);
            ToolResultBlock::success(
                context.tool_use().tool_use_id.clone(),
                vec![ToolResultContent::text(format!("{name} done"))],
            )
            .into()
        })
    }
}

enum Command {
    Emit(JsonValue),
    Complete,
}

type Acked = (Command, oneshot::Sender<()>);

/// A streaming tool: [`emit`](Self::emit) yields one progress event and returns once the agent
/// has dispatched it; [`complete`](Self::complete) ends the stream.
#[derive(Clone)]
pub struct GatedStreamingTool {
    name: String,
    sender: mpsc::UnboundedSender<Acked>,
    receiver: Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<Acked>>>,
}

impl GatedStreamingTool {
    pub fn new(name: &str) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            name: name.to_owned(),
            sender,
            receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
        }
    }

    async fn send(&self, command: Command) {
        let (ack, acked) = oneshot::channel();
        self.sender.send((command, ack)).ok();
        acked.await.ok();
    }

    pub async fn emit(&self, data: JsonValue) {
        self.send(Command::Emit(data)).await;
    }

    pub async fn complete(&self) {
        self.send(Command::Complete).await;
    }
}

impl Tool for GatedStreamingTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Gated streaming tool"
    }

    fn tool_spec(&self) -> ToolSpec {
        ToolSpec::new(&self.name, "Gated streaming tool").with_input_schema(json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        let receiver = self.receiver.clone();
        let name = self.name.clone();
        ToolStream::new(async_stream::stream! {
            let mut receiver = receiver.lock_owned().await;
            while let Some((command, ack)) = receiver.recv().await {
                match command {
                    Command::Emit(data) => {
                        yield ToolStreamItem::Event(ToolStreamEvent::new(data));
                        ack.send(()).ok();
                    }
                    Command::Complete => {
                        ack.send(()).ok();
                        let result = ToolResultBlock::success(
                            context.tool_use().tool_use_id.clone(),
                            vec![ToolResultContent::text(format!("{name} done"))],
                        );
                        yield ToolStreamItem::from(result);
                        break;
                    }
                }
            }
        })
    }
}
