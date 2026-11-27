//! Crate-internal test helpers.

use std::io;
use std::sync::{Arc, LazyLock, Mutex};

use tracing::subscriber::DefaultGuard;

#[derive(Clone, Default)]
pub(crate) struct Captured(Arc<Mutex<Vec<u8>>>);

impl Captured {
    pub(crate) fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A dispatcher that lives for the whole test run and is never anyone's default. While only one
/// dispatcher exists, tracing computes a callsite's interest from the current thread's default,
/// so a callsite first hit on a thread without a recording subscriber would be cached as never
/// enabled and stay silent for the thread that records it. A second, permanent dispatcher keeps
/// tracing asking every registered dispatcher instead.
static KEEP_INTEREST: LazyLock<tracing::Dispatch> =
    LazyLock::new(|| tracing::Dispatch::new(tracing_subscriber::registry()));

fn subscriber(captured: &Captured) -> impl tracing::Subscriber + Send + Sync + use<> {
    LazyLock::force(&KEEP_INTEREST);
    let writer = captured.clone();
    tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::TRACE)
        .with_target(false)
        .finish()
}

/// Runs `f` with a subscriber that records every log line, and returns them with its result.
pub(crate) fn capture_logs<T>(f: impl FnOnce() -> T) -> (T, String) {
    let captured = Captured::default();
    let result = tracing::subscriber::with_default(subscriber(&captured), || {
        tracing::callsite::rebuild_interest_cache();
        f()
    });
    (result, captured.text())
}

/// Records log lines on the current thread until the guard drops; for single-threaded async tests.
pub(crate) fn record_logs() -> (Captured, DefaultGuard) {
    let captured = Captured::default();
    let guard = tracing::subscriber::set_default(subscriber(&captured));
    // Callsites cache their interest across threads; rebuild it so this thread's subscriber sees
    // callsites first hit while another test's subscriber was active.
    tracing::callsite::rebuild_interest_cache();
    (captured, guard)
}

type MockResult = Arc<dyn Fn(&crate::tools::ToolContext) -> crate::tools::ToolOutcome + Send + Sync>;

/// A tool for tests: succeeds with empty content unless given a result.
#[derive(Clone)]
pub(crate) struct MockTool {
    name: String,
    description: String,
    result: Option<MockResult>,
}

impl MockTool {
    pub(crate) fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            description: format!("Mock tool {name}"),
            result: None,
        }
    }

    pub(crate) fn with_description(mut self, description: &str) -> Self {
        self.description = description.to_owned();
        self
    }

    pub(crate) fn with_result(
        mut self,
        result: impl Fn(&crate::tools::ToolContext) -> crate::tools::ToolOutcome + Send + Sync + 'static,
    ) -> Self {
        self.result = Some(Arc::new(result));
        self
    }
}

impl crate::tools::Tool for MockTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn tool_spec(&self) -> crate::types::ToolSpec {
        crate::types::ToolSpec::new(&self.name, &self.description)
            .with_input_schema(serde_json::json!({"type": "object", "properties": {}}))
    }

    fn stream(&self, context: crate::tools::ToolContext) -> crate::tools::ToolStream {
        let outcome = match &self.result {
            Some(result) => result(&context),
            None => crate::types::ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]).into(),
        };
        crate::tools::ToolStream::ready(outcome)
    }
}

/// A `LocalAgent` with a mock model and empty state.
pub(crate) fn local_agent() -> crate::agent::LocalAgent {
    crate::agent::LocalAgent::new("agent-1", Arc::new(crate::testing::MockModel::new()))
}

/// A `ToolAgent` with a mock model and empty state.
pub(crate) fn tool_agent() -> crate::agent::ToolAgent {
    local_agent().tool_agent()
}
